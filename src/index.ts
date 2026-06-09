import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildJobKey, parseJobDescription } from './parsers/jd-parser.js';
import { config } from './config.js';
import { JobStore } from './storage/job-store.js';
import { BrowserSession, closeBrowserSession, ensureAuthenticatedBrowserSession } from './browser/session.js';
import { waitPlatformCandidatePace } from './browser/pacing.js';
import { createProductionExtractionBoundary } from './extraction/production-extractor.js';
import { isCrawl4aiAdapterAvailable } from './extraction/crawl4ai-extractor.js';
import { getPlatformAdapter, listSupportedPlatforms, parsePlatformArg } from './platforms/registry.js';
import { fiftyOneJobAdapter } from './platforms/51job-adapter.js';
import type { CandidatePostOpenActions, PlatformAdapter, SupportedPlatform } from './platforms/types.js';
import { answerCandidateQuestionFromJd, toJdRagSources, type JdRagSource } from './rag/jd-question-answering.js';
import { answerQuestionWithRag } from './rag/service.js';
import { buildApplicationFilterConditions, loadApplicationFilterInputFile, loadSearchConditionPlanFile, runSearchSubscriptionWorkflow } from './search/search-subscription.js';
import { scoreResumeAgainstJob } from './scoring/score-resume.js';
import { exportJobResults, type ExportJobResultsSummary } from './scripts/export-job-results.js';
import { sendJobReport, type SendJobReportSummary } from './scripts/send-job-report-email.js';
import { CandidateListItem, JobRecord, NormalizedJob, parseEmailList, ReportDeliveryOptions, resolveReportDelivery, RunResult, SearchCondition, SearchSubscriptionSummary } from './types/job.js';

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
type SearchSource = 'saved' | 'direct';

interface RunnableJobInput extends ReportDeliveryOptions {
  searchKeyword: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  liepinForwardContact?: string;
  searchSource: SearchSource;
  applicationFilterInputFilePath?: string;
}

interface SingleJobCliInput extends RunnableJobInput {
  mode: 'single';
  platform: CliPlatformSelection;
}

interface BatchCliInput extends ReportDeliveryOptions {
  mode: 'batch';
  platform: CliPlatformSelection;
  jobsFilePath: string;
  includeViewedCandidates: boolean;
  liepinForwardContact?: string;
  searchSource: SearchSource;
  applicationFilterInputFilePath?: string;
}

interface SearchSubscriptionCliInput {
  mode: 'search-subscription';
  platform: CliPlatformSelection;
  keyword?: string;
  filePath: string;
  save: boolean;
  savedSearchName?: string;
}

interface JdQuestionCliInput {
  mode: 'jd-question';
  platform: CliPlatformSelection;
  keyword?: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  question: string;
}

interface BatchRunnableJobInput extends RunnableJobInput {
  sourceIndex: number;
}

type CliInput = SingleJobCliInput | BatchCliInput | SearchSubscriptionCliInput | JdQuestionCliInput;

interface SinglePlatformCliInput extends ReportDeliveryOptions {
  platform: SupportedPlatform;
  searchKeyword: string;
  jobDescriptionText?: string;
  jobDescriptionFilePath?: string;
  includeViewedCandidates: boolean;
  liepinForwardContact?: string;
  searchSource: SearchSource;
  applicationFilterInputFilePath?: string;
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

export interface BatchJobRunSummary {
  keyword: string;
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export interface JdQuestionRunSummary {
  platform: SupportedPlatform;
  jobKey?: string;
  question: string;
  answer: string;
  sources: JdRagSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

export type MainResult = MainRunSummary
  | AllPlatformsRunSummary[]
  | BatchJobRunSummary[]
  | SearchSubscriptionSummary
  | SearchSubscriptionSummary[]
  | JdQuestionRunSummary
  | JdQuestionRunSummary[];

export const parseJobDescriptionRef = { fn: parseJobDescription };
export const extractionBoundary = createProductionExtractionBoundary();
export const openSubscribeSearchRef = { fn: fiftyOneJobAdapter.openSubscribeSearch };
export const openDirectSearchRef = { fn: fiftyOneJobAdapter.openDirectSearch };
export const openResumeDetailRef = { fn: fiftyOneJobAdapter.openResumeDetail };
export const extractCandidateListRef = {
  fn: extractionBoundary.extractCandidateListFromPage,
};
export const extractCandidateListWithAdapterRef = {
  fn: async (
    adapter: PlatformAdapter,
    page: Awaited<ReturnType<PlatformAdapter['openSubscribeSearch']>>,
    options?: Parameters<PlatformAdapter['extractCandidateList']>[1],
  ) => adapter.extractCandidateList(page, options),
};
export const extractResumeFromPageRef = {
  fn: extractionBoundary.extractResumeFromPage,
};
export const scoreResumeAgainstJobRef = { fn: scoreResumeAgainstJob };
export const exportJobResultsRef = { fn: exportJobResults };
export const sendJobReportRef = { fn: sendJobReport };
export const ensureAuthenticatedBrowserSessionRef = { fn: ensureAuthenticatedBrowserSession };
export const closeBrowserSessionRef = { fn: closeBrowserSession };
export const runSearchSubscriptionWorkflowRef = { fn: runSearchSubscriptionWorkflow };
export const waitPlatformCandidatePaceRef = { fn: waitPlatformCandidatePace };
export const answerCandidateQuestionFromJdRef = { fn: answerCandidateQuestionFromJd };
export const answerQuestionWithRagRef = { fn: answerQuestionWithRag };
export { JobStore };

export function resolvePlatformAdapter(platform: SupportedPlatform): PlatformAdapter {
  const adapter = getPlatformAdapter(platform);

  if (platform === '51job') {
    return {
      ...adapter,
      openSubscribeSearch: openSubscribeSearchRef.fn,
      ...(openDirectSearchRef.fn ? { openDirectSearch: openDirectSearchRef.fn } : {}),
      extractCandidateList: async (page, options) => extractCandidateListRef.fn(page, options),
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

function parseOptionalBoolean(value: string | undefined, argumentName: string): boolean {
  if (value === undefined) {
    return true;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${argumentName} must be true or false`);
}

function parseSearchSource(value: string | undefined, argumentName: string): SearchSource {
  if (value === undefined) {
    return 'saved';
  }

  if (value === 'saved' || value === 'direct') {
    return value;
  }

  throw new Error(`${argumentName} must be saved or direct`);
}

function parseBatchCcEmails(value: unknown, itemIndex: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return parseEmailList(value);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return parseEmailList(value.join(','));
  }

  throw new Error(`Invalid jobs-file item at index ${itemIndex}: cc must be a string or string array`);
}

function parseOptionalString(value: unknown, fieldName: string, itemIndex: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: ${fieldName} must be a string`);
  }

  return value;
}

function parseBatchJobItem(value: unknown, itemIndex: number, input: BatchCliInput): BatchRunnableJobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: item must be an object`);
  }

  const item = value as Record<string, unknown>;
  const keyword = parseOptionalString(item.keyword, 'keyword', itemIndex)?.trim();
  const jd = parseOptionalString(item.jd, 'jd', itemIndex);
  const jdFile = parseOptionalString(item.jdFile, 'jdFile', itemIndex);
  const email = parseOptionalString(item.email, 'email', itemIndex);
  const itemSearchSourceValue = parseOptionalString(item.searchSource, 'searchSource', itemIndex);
  const itemApplicationFilterInputFile = parseOptionalString(item.applicationFilterInputFile, 'applicationFilterInputFile', itemIndex);
  const itemCcEmails = parseBatchCcEmails(item.cc, itemIndex);
  const searchSource = parseSearchSource(itemSearchSourceValue, `jobs-file item ${itemIndex}.searchSource`);
  const hasItemSearchSource = item.searchSource !== undefined;
  const effectiveSearchSource = item.searchSource === undefined ? input.searchSource : searchSource;
  const effectiveApplicationFilterInputFilePath = itemApplicationFilterInputFile
    ? path.resolve(path.dirname(path.resolve(input.jobsFilePath)), itemApplicationFilterInputFile)
    : (hasItemSearchSource && effectiveSearchSource === 'saved' ? undefined : input.applicationFilterInputFilePath);

  if (!keyword) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: keyword must be a non-empty string`);
  }

  if (jd !== undefined && jdFile !== undefined) {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: jd and jdFile are mutually exclusive`);
  }

  if (effectiveApplicationFilterInputFilePath && effectiveSearchSource !== 'direct') {
    throw new Error(`Invalid jobs-file item at index ${itemIndex}: applicationFilterInputFile requires searchSource direct`);
  }

  return {
    sourceIndex: itemIndex,
    searchKeyword: keyword,
    recipientEmail: email ?? input.recipientEmail,
    ccEmails: item.cc === undefined ? input.ccEmails : itemCcEmails,
    jobDescriptionText: jd,
    jobDescriptionFilePath: jdFile,
    includeViewedCandidates: input.includeViewedCandidates,
    liepinForwardContact: input.liepinForwardContact,
    searchSource: effectiveSearchSource,
    applicationFilterInputFilePath: effectiveApplicationFilterInputFilePath,
  };
}

async function loadBatchJobInputs(input: BatchCliInput): Promise<BatchRunnableJobInput[]> {
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(input.jobsFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in --jobs-file ${input.jobsFilePath}: ${error.message}`);
    }

    throw error;
  }

  if (!Array.isArray(payload)) {
    throw new Error('--jobs-file must contain a JSON array');
  }

  return payload.map((item, index) => parseBatchJobItem(item, index, input));
}

function listSelectedPlatforms(platform: CliPlatformSelection): SupportedPlatform[] {
  return platform === 'all' ? listSupportedPlatforms() : [platform];
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
  const jobsFilePath = values.get('jobs-file');
  const jobDescriptionText = values.get('jd');
  const jobDescriptionFilePath = values.get('jd-file');
  const recipientEmail = values.get('email');
  const ccEmails = flagPresence.has('cc') ? parseEmailList(values.get('cc')) : undefined;
  const searchSubscriptionFilePath = values.get('search-subscription-file');
  const saveSearchSubscription = flagPresence.has('save-search-subscription')
    ? parseOptionalBoolean(values.get('save-search-subscription'), '--save-search-subscription')
    : false;
  const searchSubscriptionName = values.get('search-subscription-name');
  const hasJdQuestion = flagPresence.has('jd-question') || flagPresence.has('rag-question');
  const jdQuestion = values.get('jd-question') ?? values.get('rag-question');
  const includeViewedCandidates = flagPresence.has('include-viewed')
    ? parseOptionalBoolean(values.get('include-viewed'), '--include-viewed')
    : false;
  const liepinForwardContact = values.get('liepin-forward-contact')?.trim();
  const searchSource = parseSearchSource(values.get('search-source'), '--search-source');
  const applicationFilterInputFilePath = values.get('application-filter-input-file')
    ? path.resolve(values.get('application-filter-input-file')!)
    : undefined;

  if (flagPresence.has('liepin-forward-contact')) {
    if (!liepinForwardContact) {
      throw new Error('--liepin-forward-contact must be a non-empty string');
    }

    if (platform !== 'liepin' && platform !== 'all') {
      throw new Error('--liepin-forward-contact can only be used with --platform liepin or --platform all');
    }
  }

  if (hasJdQuestion) {
    if (flagPresence.has('jd-question') && flagPresence.has('rag-question')) {
      throw new Error('--jd-question and --rag-question are aliases; provide only one');
    }

    if (!jdQuestion?.trim()) {
      throw new Error('--jd-question must be a non-empty string');
    }

    if (jobsFilePath || searchSubscriptionFilePath || flagPresence.has('email') || flagPresence.has('cc') || flagPresence.has('include-viewed') || flagPresence.has('liepin-forward-contact') || flagPresence.has('search-source') || flagPresence.has('application-filter-input-file') || saveSearchSubscription || searchSubscriptionName) {
      throw new Error('--jd-question cannot be combined with --jobs-file, --search-subscription-file, --email, --cc, --include-viewed, --liepin-forward-contact, --search-source, --application-filter-input-file, --save-search-subscription, or --search-subscription-name');
    }

    if (jobDescriptionText && jobDescriptionFilePath) {
      throw new Error('Arguments --jd and --jd-file are mutually exclusive');
    }

    if (!searchKeyword && !jobDescriptionText && !jobDescriptionFilePath) {
      throw new Error('--jd-question requires --keyword for a stored JD or new JD input through --jd/--jd-file');
    }

    return {
      mode: 'jd-question',
      platform,
      keyword: searchKeyword,
      jobDescriptionText,
      jobDescriptionFilePath,
      question: jdQuestion.trim(),
    };
  }

  if (searchSubscriptionFilePath) {
    if (jobsFilePath || flagPresence.has('jd') || flagPresence.has('jd-file') || flagPresence.has('email') || flagPresence.has('cc') || flagPresence.has('include-viewed') || flagPresence.has('liepin-forward-contact') || flagPresence.has('search-source') || flagPresence.has('application-filter-input-file')) {
      throw new Error('--search-subscription-file cannot be combined with --jobs-file, --jd, --jd-file, --email, --cc, --include-viewed, --liepin-forward-contact, --search-source, or --application-filter-input-file');
    }

    return {
      mode: 'search-subscription',
      platform,
      keyword: searchKeyword,
      filePath: searchSubscriptionFilePath,
      save: saveSearchSubscription,
      savedSearchName: searchSubscriptionName,
    };
  }

  if (saveSearchSubscription || searchSubscriptionName) {
    throw new Error('--save-search-subscription and --search-subscription-name require --search-subscription-file');
  }

  if (jobsFilePath) {
    if (flagPresence.has('keyword') || flagPresence.has('jd') || flagPresence.has('jd-file')) {
      throw new Error('--jobs-file cannot be combined with --keyword, --jd, or --jd-file');
    }

    if (applicationFilterInputFilePath && searchSource !== 'direct') {
      throw new Error('--application-filter-input-file requires --search-source direct');
    }

    return {
      mode: 'batch',
      platform,
      jobsFilePath,
      recipientEmail,
      ccEmails,
      includeViewedCandidates,
      liepinForwardContact,
      searchSource,
      applicationFilterInputFilePath,
    };
  }

  if (!searchKeyword) {
    throw new Error('Missing required argument --keyword');
  }

  if (jobDescriptionText && jobDescriptionFilePath) {
    throw new Error('Arguments --jd and --jd-file are mutually exclusive');
  }

  if (applicationFilterInputFilePath && searchSource !== 'direct') {
    throw new Error('--application-filter-input-file requires --search-source direct');
  }

  return {
    mode: 'single',
    platform,
    searchKeyword,
    recipientEmail,
    ccEmails,
    jobDescriptionText,
    jobDescriptionFilePath,
    includeViewedCandidates,
    liepinForwardContact,
    searchSource,
    applicationFilterInputFilePath,
  };
}

function buildSinglePlatformInput(input: RunnableJobInput, platform: SupportedPlatform): SinglePlatformCliInput {
  return {
    platform,
    searchKeyword: input.searchKeyword,
    recipientEmail: input.recipientEmail,
    ccEmails: input.ccEmails,
    jobDescriptionText: input.jobDescriptionText,
    jobDescriptionFilePath: input.jobDescriptionFilePath,
    includeViewedCandidates: input.includeViewedCandidates,
    liepinForwardContact: input.liepinForwardContact,
    searchSource: input.searchSource,
    applicationFilterInputFilePath: input.applicationFilterInputFilePath,
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
  postOpenActions: CandidatePostOpenActions = {},
): Promise<CandidateProcessResult> {
  let detailPage = session.page;
  let preserveDetailPageForInspection = false;

  try {
    detailPage = await platformAdapter.openResumeDetail(session.context, searchPage, candidate);
    await platformAdapter.afterResumeDetailOpened?.(detailPage, candidate, postOpenActions);
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
    if (platform === 'liepin') {
      preserveDetailPageForInspection = true;
      throw new Error(`Liepin candidate ${candidate.candidateId} failed; stopping flow and leaving the browser open for inspection. Original error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      candidateId: candidate.candidateId,
      markAsSeen: false,
      captured: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!preserveDetailPageForInspection && detailPage !== session.page && detailPage !== searchPage) {
      await detailPage.close().catch(() => undefined);
      await (searchPage as Partial<Pick<typeof searchPage, 'bringToFront'>>).bringToFront?.call(searchPage).catch(() => undefined);
      session.page = searchPage;
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
      candidateShareUrl: resume.candidateShareUrl,
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

export async function runResumeCaptureFlow(platform: SupportedPlatform, jobKey: string, job: NormalizedJob, searchKeyword: string, store: JobStore, session: BrowserSession, fetchedAt: string, platformAdapter: PlatformAdapter, options: { includeViewedCandidates?: boolean; liepinForwardContact?: string; searchSource?: SearchSource; searchConditions?: SearchCondition[] } = {}): Promise<{ candidates: CandidateListItem[]; newCandidates: CandidateListItem[]; runResult: RunResult; resultPath: string }> {
  const searchDeadline = Date.now() + config.playwright.searchPageTimeoutMs;
  const searchOptions = {
    deadline: searchDeadline,
    includeViewedCandidates: options.includeViewedCandidates,
  };
  const searchSource = options.searchSource ?? 'saved';
  const searchConditions = options.searchConditions ?? [];
  const searchPage = searchSource === 'direct'
    ? await (async () => {
      if (!platformAdapter.openDirectSearch) {
        throw new Error(`Platform ${platformAdapter.platform} does not support direct search for resume capture.`);
      }

      return platformAdapter.openDirectSearch(session.page, searchKeyword, searchConditions, searchOptions);
    })()
    : await platformAdapter.openSubscribeSearch(session.page, searchKeyword, searchOptions);
  session.page = searchPage;
  const { candidates } = platformAdapter.platform === '51job'
    ? await extractCandidateListRef.fn(searchPage, { deadline: searchDeadline })
    : await extractCandidateListWithAdapterRef.fn(platformAdapter, searchPage, { deadline: searchDeadline });
  const seenCandidateIdsBeforeRun = await store.readSeenIds(platform, jobKey);
  const seenCandidateIdsSet = new Set(seenCandidateIdsBeforeRun);
  const newCandidates = candidates.filter((candidate) => !seenCandidateIdsSet.has(candidate.candidateId));
  const candidateResults: CandidateProcessResult[] = [];

  for (const candidate of newCandidates) {
    if (candidateResults.length > 0) {
      await waitPlatformCandidatePaceRef.fn(searchPage, platform);
    }

    candidateResults.push(await captureCandidateResume(platform, jobKey, candidate, store, session, searchPage, platformAdapter, {
      liepinForwardContact: platform === 'liepin' ? options.liepinForwardContact : undefined,
    }));
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

async function buildResumeCaptureSearchConditions(input: SinglePlatformCliInput): Promise<SearchCondition[]> {
  if (!input.applicationFilterInputFilePath) {
    return [];
  }

  const applicationFilterInput = await loadApplicationFilterInputFile(input.applicationFilterInputFilePath);
  return buildApplicationFilterConditions(input.platform, applicationFilterInput, {});
}

async function runSinglePlatform(input: SinglePlatformCliInput, options: { printSummary: boolean } = { printSummary: true }): Promise<MainRunSummary> {
  const platformAdapter = resolvePlatformAdapter(input.platform);
  const store = new JobStore();
  const jobKey = buildJobKey(input.searchKeyword, '');
  const fetchedAt = new Date().toISOString();
  const existingJobRecord = await store.readJobRecordIfExists(input.platform, jobKey);
  const searchConditions = await buildResumeCaptureSearchConditions(input);

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
      {
        includeViewedCandidates: input.includeViewedCandidates,
        liepinForwardContact: input.liepinForwardContact,
        searchSource: input.searchSource,
        searchConditions,
      },
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

async function runBatchJobs(input: BatchCliInput): Promise<BatchJobRunSummary[]> {
  const jobs = await loadBatchJobInputs(input);
  const summaries: BatchJobRunSummary[] = [];

  for (const job of jobs) {
    for (const platform of listSelectedPlatforms(input.platform)) {
      summaries.push({
        keyword: job.searchKeyword,
        platform,
        summary: await runSinglePlatform(buildSinglePlatformInput(job, platform), { printSummary: false }),
      });
    }
  }

  console.log(JSON.stringify(summaries, null, 2));
  return summaries;
}

async function runSearchSubscription(input: SearchSubscriptionCliInput): Promise<SearchSubscriptionSummary | SearchSubscriptionSummary[]> {
  const summaries: SearchSubscriptionSummary[] = [];

  for (const platform of listSelectedPlatforms(input.platform)) {
    const adapter = resolvePlatformAdapter(platform);
    const plan = await loadSearchConditionPlanFile(input.filePath, {
      platform,
      keywordOverride: input.keyword,
      savedSearchNameOverride: input.savedSearchName,
    });
    const session = await ensureAuthenticatedBrowserSessionRef.fn(adapter.platform);

    try {
      summaries.push(await runSearchSubscriptionWorkflowRef.fn(adapter, session.page, plan, {
        save: input.save,
        savedSearchName: input.savedSearchName,
      }));
    } finally {
      await closeBrowserSessionRef.fn(session);
    }
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function resolveJdQuestionContext(
  platform: SupportedPlatform,
  input: JdQuestionCliInput,
  store: JobStore,
): Promise<{ jobKey?: string; rawText: string; normalizedJob?: NormalizedJob; stored: boolean }> {
  const keyword = input.keyword?.trim();
  const jobKey = keyword ? buildJobKey(keyword, '') : undefined;
  const existingJobRecord = jobKey ? await store.readJobRecordIfExists(platform, jobKey) : undefined;

  if (existingJobRecord) {
    return {
      jobKey,
      rawText: existingJobRecord.rawText,
      normalizedJob: existingJobRecord.normalizedJob,
      stored: true,
    };
  }

  if (!input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error(`Missing stored JD for ${platform}${jobKey ? ` job key ${jobKey}` : ''}; provide --jd or --jd-file`);
  }

  const rawText = input.jobDescriptionText ?? await readFile(input.jobDescriptionFilePath!, 'utf8');

  return {
    jobKey,
    rawText,
    stored: false,
  };
}

async function runJdQuestion(input: JdQuestionCliInput): Promise<JdQuestionRunSummary | JdQuestionRunSummary[]> {
  const store = new JobStore();
  const summaries: JdQuestionRunSummary[] = [];

  for (const platform of listSelectedPlatforms(input.platform)) {
    const context = await resolveJdQuestionContext(platform, input, store);
    const answer = context.stored && context.jobKey
      ? await answerQuestionWithRagRef.fn({
        platform,
        jobKey: context.jobKey,
        question: input.question,
      }).then((ragAnswer) => ({
        answer: ragAnswer.answer,
        sources: toJdRagSources(ragAnswer.sources),
        answered: ragAnswer.answered,
        confidence: ragAnswer.confidence,
        noAnswerReason: ragAnswer.noAnswerReason,
      }))
      : await answerCandidateQuestionFromJdRef.fn({
        rawJdText: context.rawText,
        normalizedJob: context.normalizedJob,
        question: input.question,
      });

    summaries.push({
      platform,
      jobKey: context.jobKey,
      question: input.question,
      answer: answer.answer,
      sources: answer.sources,
      answered: answer.answered,
      confidence: answer.confidence,
      noAnswerReason: answer.noAnswerReason,
    });
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<MainResult> {
  const input = parseArgs(argv);

  if (input.mode === 'jd-question') {
    return runJdQuestion(input);
  }

  if (input.mode === 'search-subscription') {
    return runSearchSubscription(input);
  }

  if (input.mode === 'batch') {
    return runBatchJobs(input);
  }

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
