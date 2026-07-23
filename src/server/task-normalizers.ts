import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { BossForwardMode, SupportedPlatform } from '../platforms/types.js';
import type {
  BatchTaskInput,
  BossAutoChatTaskInput,
  BossChatOperationTaskInput,
  BossGreetTaskInput,
  BossJobSyncTaskInput,
  BossTalentSearchTaskInput,
  ConsolePlatformSelection,
  LoginRefreshTaskInput,
  RagAnswerInput,
  RagOpsAction,
  RagOpsTaskInput,
  ResumeCaptureTaskInput,
  SchedulableTaskKind,
  SearchSource,
  SearchSubscriptionTaskInput,
  TaskInput,
} from './types.js';
import type { BossChatOperation, BossTalentSource } from '../types/boss.js';
import type { AskRagQuestionOptions, IngestConversationOptions } from '../rag/service.js';
import type { RagConversationTurn, RagSpeaker } from '../rag/types.js';

export type JsonObject = Record<string, unknown>;

export type NormalizedTask<TInput> = {
  input: TInput;
  argv: string[];
  inputSummary: Record<string, unknown>;
};

export type NormalizedSchedulableTask = NormalizedTask<TaskInput> & {
  kind: SchedulableTaskKind;
};

export type NormalizedRagAnswerRequest =
  | {
    mode: 'stored';
    options: AskRagQuestionOptions;
  }
  | {
    mode: 'temporary-jd';
    platform: SupportedPlatform;
    jobKey?: string;
    question: string;
    jd?: string;
    jdFile?: string;
  };

export function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value as JsonObject;
}

export function getOptionalString(item: JsonObject, fieldName: string): string | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string when provided`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getRequiredString(item: JsonObject, fieldName: string): string {
  const value = getOptionalString(item, fieldName);
  if (!value) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

export function getOptionalBoolean(item: JsonObject, fieldName: string): boolean | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

export function getOptionalPositiveInteger(item: JsonObject, fieldName: string): number | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value;
}

export function getOptionalNumberInRange(
  item: JsonObject,
  fieldName: string,
  min: number,
  max: number,
): number | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be a number from ${min} to ${max}`);
  }

  return value;
}

export function getOptionalMetadata(item: JsonObject, fieldName: string): Record<string, unknown> | undefined {
  const value = item[fieldName];
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object when provided`);
  }

  return value as Record<string, unknown>;
}

export function normalizePlatformSelection(value: unknown): ConsolePlatformSelection {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('platform is required');
  }

  const trimmed = value.trim();
  return trimmed === 'all' ? 'all' : parsePlatformArg(trimmed);
}

export function normalizePlatform(value: unknown): SupportedPlatform {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('platform is required');
  }

  return parsePlatformArg(value.trim());
}

export function normalizeSearchSource(value: unknown): SearchSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'saved' || value === 'direct') {
    return value;
  }

  throw new Error('searchSource must be saved or direct');
}

function normalizeBossForwardMode(value: unknown): BossForwardMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'colleague' || value === 'email') {
    return value;
  }

  throw new Error('bossForwardMode must be colleague or email');
}

function normalizeBossForwarding(
  item: JsonObject,
  platform: ConsolePlatformSelection,
): { bossForwardMode?: BossForwardMode; bossForwardRecipient?: string } {
  const bossForwardMode = normalizeBossForwardMode(getOptionalString(item, 'bossForwardMode'));
  const bossForwardRecipient = getOptionalString(item, 'bossForwardRecipient');
  if (Boolean(bossForwardMode) !== Boolean(bossForwardRecipient)) {
    throw new Error('bossForwardMode and bossForwardRecipient must be provided together');
  }

  if (bossForwardMode && platform !== 'boss') {
    throw new Error('Boss forwarding can only be used with platform boss');
  }

  return { bossForwardMode, bossForwardRecipient };
}

function normalizeCc(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const items = value.map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  throw new Error('cc must be a string or string array');
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function pushOptional(argv: string[], flagName: string, value: string | undefined): void {
  if (value !== undefined) {
    argv.push(flagName, value);
  }
}

function pushOptionalBoolean(argv: string[], flagName: string, value: boolean | undefined): void {
  if (value !== undefined) {
    argv.push(flagName, String(value));
  }
}

function assertAbsent(item: JsonObject, fieldNames: string[], context: string): void {
  const present = fieldNames.filter((fieldName) => item[fieldName] !== undefined);
  if (present.length > 0) {
    throw new Error(`${context} cannot include ${present.join(', ')}`);
  }
}

function summarizeText(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function normalizeResumeCaptureTask(payload: unknown): NormalizedTask<ResumeCaptureTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatformSelection(item.platform);
  const keyword = getRequiredString(item, 'keyword');
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');
  const includeViewed = getOptionalBoolean(item, 'includeViewed');
  const searchSource = normalizeSearchSource(item.searchSource);
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const email = getOptionalString(item, 'email');
  const cc = normalizeCc(item.cc);
  const liepinForwardContact = getOptionalString(item, 'liepinForwardContact');
  const { bossForwardMode, bossForwardRecipient } = normalizeBossForwarding(item, platform);

  if (jd && jdFile) {
    throw new Error('jd and jdFile are mutually exclusive');
  }

  if (applicationFilterInputFile && searchSource !== 'direct') {
    throw new Error('applicationFilterInputFile requires searchSource direct');
  }

  if (liepinForwardContact && platform !== 'liepin' && platform !== 'all') {
    throw new Error('liepinForwardContact can only be used with platform liepin or all');
  }

  const input: ResumeCaptureTaskInput = {
    platform,
    keyword,
    jd,
    jdFile,
    includeViewed,
    searchSource,
    applicationFilterInputFile,
    email,
    cc,
    liepinForwardContact,
    bossForwardMode,
    bossForwardRecipient,
  };
  const argv = ['--platform', platform, '--keyword', keyword];
  pushOptional(argv, '--jd', jd);
  pushOptional(argv, '--jd-file', jdFile);
  pushOptionalBoolean(argv, '--include-viewed', includeViewed);
  pushOptional(argv, '--search-source', searchSource);
  pushOptional(argv, '--application-filter-input-file', applicationFilterInputFile);
  pushOptional(argv, '--email', email);
  pushOptional(argv, '--cc', cc?.join(','));
  pushOptional(argv, '--liepin-forward-contact', liepinForwardContact);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);

  return {
    input,
    argv,
    inputSummary: {
      platform,
      keyword,
      hasJd: Boolean(jd),
      jdPreview: summarizeText(jd),
      jdFile,
      includeViewed: includeViewed ?? false,
      searchSource: searchSource ?? 'stored-or-saved',
      applicationFilterInputFile,
      email,
      ccCount: cc?.length ?? 0,
      liepinForwardContact,
      bossForwardMode,
      bossForwardRecipient,
    },
  };
}

export function normalizeBatchTask(payload: unknown): NormalizedTask<BatchTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertAbsent(item, ['keyword', 'jd', 'jdFile'], 'batch task');

  const platform = normalizePlatformSelection(item.platform);
  const jobsFile = getRequiredString(item, 'jobsFile');
  const includeViewed = getOptionalBoolean(item, 'includeViewed');
  const searchSource = normalizeSearchSource(item.searchSource);
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const email = getOptionalString(item, 'email');
  const cc = normalizeCc(item.cc);
  const liepinForwardContact = getOptionalString(item, 'liepinForwardContact');
  const { bossForwardMode, bossForwardRecipient } = normalizeBossForwarding(item, platform);

  if (applicationFilterInputFile && searchSource !== 'direct') {
    throw new Error('applicationFilterInputFile requires searchSource direct');
  }

  if (liepinForwardContact && platform !== 'liepin' && platform !== 'all') {
    throw new Error('liepinForwardContact can only be used with platform liepin or all');
  }

  const input: BatchTaskInput = {
    platform,
    jobsFile,
    includeViewed,
    searchSource,
    applicationFilterInputFile,
    email,
    cc,
    liepinForwardContact,
    bossForwardMode,
    bossForwardRecipient,
  };
  const argv = ['--platform', platform, '--jobs-file', jobsFile];
  pushOptionalBoolean(argv, '--include-viewed', includeViewed);
  pushOptional(argv, '--search-source', searchSource);
  pushOptional(argv, '--application-filter-input-file', applicationFilterInputFile);
  pushOptional(argv, '--email', email);
  pushOptional(argv, '--cc', cc?.join(','));
  pushOptional(argv, '--liepin-forward-contact', liepinForwardContact);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);

  return {
    input,
    argv,
    inputSummary: {
      platform,
      jobsFile,
      includeViewed: includeViewed ?? false,
      searchSource: searchSource ?? 'stored-or-saved',
      applicationFilterInputFile,
      email,
      ccCount: cc?.length ?? 0,
      liepinForwardContact,
      bossForwardMode,
      bossForwardRecipient,
    },
  };
}

export function normalizeSearchSubscriptionTask(payload: unknown): NormalizedTask<SearchSubscriptionTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertAbsent(item, ['jd', 'jdFile', 'email', 'cc', 'includeViewed', 'liepinForwardContact', 'bossForwardMode', 'bossForwardRecipient', 'searchSource'], 'search-subscription task');

  const platform = normalizePlatformSelection(item.platform);
  const searchSubscriptionFile = getRequiredString(item, 'searchSubscriptionFile');
  const keyword = getOptionalString(item, 'keyword');
  const applicationFilterInputFile = getOptionalString(item, 'applicationFilterInputFile');
  const saveSearchSubscription = getOptionalBoolean(item, 'saveSearchSubscription');
  const searchSubscriptionName = getOptionalString(item, 'searchSubscriptionName');

  const input: SearchSubscriptionTaskInput = {
    platform,
    searchSubscriptionFile,
    keyword,
    applicationFilterInputFile,
    saveSearchSubscription,
    searchSubscriptionName,
  };
  const argv = ['--platform', platform, '--search-subscription-file', searchSubscriptionFile];
  pushOptional(argv, '--keyword', keyword);
  pushOptionalBoolean(argv, '--save-search-subscription', saveSearchSubscription);
  pushOptional(argv, '--search-subscription-name', searchSubscriptionName);

  return {
    input,
    argv,
    inputSummary: {
      platform,
      searchSubscriptionFile,
      keyword,
      applicationFilterInputFile,
      saveSearchSubscription: saveSearchSubscription ?? false,
      searchSubscriptionName,
    },
  };
}

export function normalizeBossAutoChatTask(payload: unknown): NormalizedTask<BossAutoChatTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  assertAbsent(item, [
    'keyword',
    'jd',
    'jdFile',
    'jobsFile',
    'includeViewed',
    'searchSource',
    'applicationFilterInputFile',
    'email',
    'cc',
    'liepinForwardContact',
    'searchSubscriptionFile',
    'saveSearchSubscription',
    'searchSubscriptionName',
  ], 'boss-auto-chat task');

  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') {
    throw new Error('boss-auto-chat task requires platform boss');
  }

  const scoreThreshold = getOptionalNumberInRange(item, 'scoreThreshold', 0, 100);
  const requireAllHardRequirements = getOptionalBoolean(item, 'requireAllHardRequirements');
  const replyToUnqualifiedCandidates = getOptionalBoolean(item, 'replyToUnqualifiedCandidates');
  const syncJobsBeforeReview = getOptionalBoolean(item, 'syncJobsBeforeReview');
  const summaryEmail = getOptionalString(item, 'summaryEmail');
  const summaryCc = normalizeCc(item.summaryCc);
  if (summaryCc && !summaryEmail) {
    throw new Error('boss-auto-chat summaryCc requires summaryEmail');
  }
  const { bossForwardMode, bossForwardRecipient } = normalizeBossForwarding(item, platform);

  const input: BossAutoChatTaskInput = {
    platform: 'boss',
    scoreThreshold,
    requireAllHardRequirements,
    replyToUnqualifiedCandidates,
    bossForwardMode,
    bossForwardRecipient,
    summaryEmail,
    summaryCc,
    syncJobsBeforeReview,
  };
  const argv = ['--platform', 'boss', '--boss-auto-chat', 'true'];
  if (scoreThreshold !== undefined) {
    argv.push('--boss-chat-score-threshold', String(scoreThreshold));
  }
  pushOptionalBoolean(argv, '--boss-chat-require-all', requireAllHardRequirements);
  pushOptionalBoolean(argv, '--boss-chat-reply-unqualified', replyToUnqualifiedCandidates);
  pushOptional(argv, '--boss-forward-mode', bossForwardMode);
  pushOptional(argv, '--boss-forward-recipient', bossForwardRecipient);
  pushOptional(argv, '--boss-chat-summary-email', summaryEmail);
  pushOptional(argv, '--boss-chat-summary-cc', summaryCc?.join(','));
  pushOptionalBoolean(argv, '--boss-sync-jobs-before-review', syncJobsBeforeReview);

  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss',
      scoreThreshold: scoreThreshold ?? 70,
      requireAllHardRequirements: requireAllHardRequirements ?? false,
      replyToUnqualifiedCandidates: replyToUnqualifiedCandidates ?? false,
      bossForwardMode,
      bossForwardRecipient,
      summaryEmail,
      summaryCcCount: summaryCc?.length ?? 0,
      syncJobsBeforeReview: syncJobsBeforeReview ?? false,
    },
  };
}

export function normalizeBossTalentSearchTask(payload: unknown): NormalizedTask<BossTalentSearchTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-talent-search task requires platform boss');
  if (item.source !== 'recommend' && item.source !== 'deep-search') {
    throw new Error('source must be recommend or deep-search');
  }
  const source = item.source;
  const bossJobId = getOptionalString(item, 'bossJobId');
  const expectedJobName = getOptionalString(item, 'expectedJobName');
  const coreRequirements = normalizeStringArray(item.coreRequirements, 'coreRequirements');
  const bonusRequirements = normalizeStringArray(item.bonusRequirements, 'bonusRequirements');
  const triggerMatch = getOptionalBoolean(item, 'triggerMatch');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (source === 'recommend' && (coreRequirements || bonusRequirements || triggerMatch)) {
    throw new Error('Boss recommendation does not accept requirements or triggerMatch');
  }
  if (triggerMatch === true && confirmed !== true) {
    throw new Error('Boss immediate match requires confirmed=true');
  }
  const input: BossTalentSearchTaskInput = {
    platform: 'boss',
    source,
    bossJobId,
    expectedJobName,
    coreRequirements,
    bonusRequirements,
    triggerMatch,
    confirmed,
  };
  const argv = ['--platform', 'boss', '--boss-talent-source', source];
  pushOptional(argv, '--boss-job-id', bossJobId);
  pushOptional(argv, '--boss-expected-job-name', expectedJobName);
  pushOptional(argv, '--boss-core-requirements-json', coreRequirements ? JSON.stringify(coreRequirements) : undefined);
  pushOptional(argv, '--boss-bonus-requirements-json', bonusRequirements ? JSON.stringify(bonusRequirements) : undefined);
  pushOptionalBoolean(argv, '--boss-trigger-match', triggerMatch);
  pushOptionalBoolean(argv, '--boss-confirmed', confirmed);
  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss', source, bossJobId, expectedJobName,
      coreRequirementCount: coreRequirements?.length ?? 0,
      bonusRequirementCount: bonusRequirements?.length ?? 0,
      triggerMatch: triggerMatch ?? false,
      confirmed: confirmed ?? false,
    },
  };
}

export function normalizeBossGreetTask(payload: unknown): NormalizedTask<BossGreetTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-greet task requires platform boss');
  const source = item.source as BossTalentSource;
  if (source !== 'recommend' && source !== 'deep-search') {
    throw new Error('boss-greet source must be recommend or deep-search');
  }
  const candidateId = getRequiredString(item, 'candidateId');
  const expectedCandidateName = getRequiredString(item, 'expectedCandidateName');
  const expectedJobName = getRequiredString(item, 'expectedJobName');
  const bossJobId = getOptionalString(item, 'bossJobId');
  const intentId = getOptionalString(item, 'intentId');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (confirmed !== true) throw new Error('boss-greet requires confirmed=true');
  const input: BossGreetTaskInput = {
    platform: 'boss', source, candidateId, expectedCandidateName, expectedJobName,
    bossJobId, intentId, confirmed: true,
  };
  const argv = [
    '--platform', 'boss',
    '--boss-greet-source', source,
    '--boss-greet-candidate-id', candidateId,
    '--boss-expected-candidate-name', expectedCandidateName,
    '--boss-expected-job-name', expectedJobName,
    '--boss-confirmed', 'true',
  ];
  pushOptional(argv, '--boss-job-id', bossJobId);
  pushOptional(argv, '--boss-intent-id', intentId);
  return {
    input,
    argv,
    inputSummary: { platform: 'boss', source, candidateId, expectedCandidateName, expectedJobName, bossJobId, intentId },
  };
}

const bossChatOperations = new Set<BossChatOperation>([
  'list-conversations', 'open-conversation', 'read-conversation', 'read-history', 'preview-resume',
  'send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume',
  'exchange-phone', 'exchange-wechat',
]);
const bossChatMutations = new Set<BossChatOperation>([
  'send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume',
  'exchange-phone', 'exchange-wechat',
]);

export function normalizeBossChatOperationTask(payload: unknown): NormalizedTask<BossChatOperationTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-chat-operation task requires platform boss');
  const action = getRequiredString(item, 'action') as BossChatOperation;
  if (!bossChatOperations.has(action)) throw new Error(`Unsupported Boss chat action: ${action}`);
  const conversationId = getOptionalString(item, 'conversationId');
  const expectedCandidateName = getOptionalString(item, 'expectedCandidateName');
  const expectedJobName = getOptionalString(item, 'expectedJobName');
  const text = getOptionalString(item, 'text');
  const remark = getOptionalString(item, 'remark');
  const intentId = getOptionalString(item, 'intentId');
  const unreadOnly = getOptionalBoolean(item, 'unreadOnly');
  const confirmed = getOptionalBoolean(item, 'confirmed');
  if (action !== 'list-conversations' && !conversationId) throw new Error(`${action} requires conversationId`);
  if (action === 'send-text' && !text) throw new Error('send-text requires text');
  if (action === 'remark' && !remark) throw new Error('remark requires remark');
  if (bossChatMutations.has(action) && (confirmed !== true || !intentId)) {
    throw new Error(`${action} requires confirmed=true and intentId`);
  }
  const input: BossChatOperationTaskInput = {
    platform: 'boss', action, conversationId, expectedCandidateName, expectedJobName,
    text, remark, intentId, unreadOnly, confirmed,
  };
  const argv = ['--platform', 'boss', '--boss-chat-operation', action];
  pushOptional(argv, '--boss-conversation-id', conversationId);
  pushOptional(argv, '--boss-expected-candidate-name', expectedCandidateName);
  pushOptional(argv, '--boss-expected-job-name', expectedJobName);
  pushOptional(argv, '--boss-chat-text', text);
  pushOptional(argv, '--boss-chat-remark', remark);
  pushOptional(argv, '--boss-intent-id', intentId);
  pushOptionalBoolean(argv, '--boss-unread-only', unreadOnly);
  pushOptionalBoolean(argv, '--boss-confirmed', confirmed);
  return {
    input,
    argv,
    inputSummary: {
      platform: 'boss', action, conversationId, expectedCandidateName, expectedJobName,
      hasText: Boolean(text), hasRemark: Boolean(remark), intentId,
      unreadOnly: unreadOnly ?? false, confirmed: confirmed ?? false,
    },
  };
}

export function normalizeBossJobSyncTask(payload: unknown): NormalizedTask<BossJobSyncTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  if (platform !== 'boss') throw new Error('boss-job-sync task requires platform boss');
  const bossJobIds = normalizeStringArray(item.bossJobIds, 'bossJobIds');
  const includeClosed = getOptionalBoolean(item, 'includeClosed');
  const input: BossJobSyncTaskInput = { platform: 'boss', bossJobIds, includeClosed };
  const argv = ['--platform', 'boss', '--boss-job-sync', 'true'];
  pushOptional(argv, '--boss-job-ids', bossJobIds?.join(','));
  pushOptionalBoolean(argv, '--boss-include-closed-jobs', includeClosed);
  return {
    input,
    argv,
    inputSummary: { platform: 'boss', bossJobIds, includeClosed: includeClosed ?? true },
  };
}

export async function prepareSearchSubscriptionTask(
  payload: unknown,
  dataDir: string,
): Promise<NormalizedTask<SearchSubscriptionTaskInput>> {
  const normalized = normalizeSearchSubscriptionTask(payload);
  const filterInputFile = normalized.input.applicationFilterInputFile;
  if (!filterInputFile) {
    return normalized;
  }

  const sourceFilePath = path.resolve(normalized.input.searchSubscriptionFile);
  const subscription = JSON.parse(await readFile(sourceFilePath, 'utf8')) as unknown;
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new Error('searchSubscriptionFile must point to a JSON object');
  }

  const runtimeDir = path.join(dataDir, 'runtime', 'search-subscriptions');
  await mkdir(runtimeDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(runtimeDir, `search-subscription-${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`);
  const filterPath = path.isAbsolute(filterInputFile)
    ? filterInputFile
    : path.resolve(filterInputFile);
  const wrappedSubscription = {
    ...(subscription as Record<string, unknown>),
    applicationFilterInputFile: path.relative(path.dirname(filePath), filterPath),
  };
  await writeFile(filePath, `${JSON.stringify(wrappedSubscription, null, 2)}\n`, 'utf8');

  normalized.input.searchSubscriptionFile = path.relative(process.cwd(), filePath);
  normalized.inputSummary.searchSubscriptionFile = normalized.input.searchSubscriptionFile;
  normalized.argv = normalized.argv.flatMap((value, index, argv) => (
    value === '--search-subscription-file' ? [value, normalized.input.searchSubscriptionFile] : index > 0 && argv[index - 1] === '--search-subscription-file' ? [] : [value]
  ));
  return normalized;
}

export async function normalizeSchedulableTask(
  kind: SchedulableTaskKind,
  input: Record<string, unknown>,
  dataDir: string,
): Promise<NormalizedSchedulableTask> {
  switch (kind) {
    case 'resume-capture': {
      const normalized = normalizeResumeCaptureTask(input);
      return { kind, ...normalized };
    }
    case 'batch': {
      const normalized = normalizeBatchTask(input);
      return { kind, ...normalized };
    }
    case 'search-subscription': {
      const normalized = await prepareSearchSubscriptionTask(input, dataDir);
      return { kind, ...normalized };
    }
    case 'boss-auto-chat': {
      const normalized = normalizeBossAutoChatTask(input);
      return { kind, ...normalized };
    }
    case 'boss-job-sync': {
      const normalized = normalizeBossJobSyncTask(input);
      return { kind, ...normalized };
    }
  }
}

export function normalizeLoginRefreshTask(payload: unknown): NormalizedTask<LoginRefreshTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  assertAbsent(item, ['keepOpen'], 'login-refresh task');

  return {
    input: { platform },
    argv: [],
    inputSummary: {
      platform,
      action: 'manual-login-refresh',
    },
  };
}

export function normalizeRagOpsAction(value: unknown): RagOpsAction {
  if (
    value === 'doctor'
    || value === 'review'
    || value === 'metrics'
    || value === 'ops'
    || value === 'rebuild'
  ) {
    return value;
  }

  throw new Error('action must be doctor, review, metrics, ops, or rebuild');
}

export function normalizeRagOpsTask(payload: unknown): NormalizedTask<RagOpsTaskInput> {
  const item = normalizeJsonObject(payload, 'request body');
  const action = normalizeRagOpsAction(item.action);
  const platform = item.platform === undefined ? undefined : normalizePlatform(item.platform);
  const jobKey = getOptionalString(item, 'jobKey');
  const keyword = getOptionalString(item, 'keyword');
  const question = getOptionalString(item, 'question');
  const file = getOptionalString(item, 'file');
  const policyFile = getOptionalString(item, 'policyFile');
  const reviewer = getOptionalString(item, 'reviewer');
  const limit = getOptionalPositiveInteger(item, 'limit');
  const includeReviewed = getOptionalBoolean(item, 'includeReviewed');
  const failOnIssue = getOptionalBoolean(item, 'failOnIssue');

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && !platform) {
    throw new Error('platform is required for this RAG operation');
  }

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && !jobKey && !keyword) {
    throw new Error('jobKey or keyword is required for this RAG operation');
  }

  if ((action === 'metrics' || action === 'ops') && !file) {
    throw new Error('file is required for this RAG operation');
  }

  if ((action === 'metrics' || action === 'rebuild') && question) {
    throw new Error(`question is not supported for ${action}`);
  }

  if ((action === 'doctor' || action === 'review' || action === 'rebuild') && file) {
    throw new Error(`file is not supported for ${action}`);
  }

  if (action !== 'metrics' && action !== 'ops' && policyFile) {
    throw new Error(`policyFile is not supported for ${action}`);
  }

  const input: RagOpsTaskInput = {
    action,
    platform,
    jobKey,
    keyword,
    question,
    file,
    policyFile,
    reviewer,
    limit,
    includeReviewed,
    failOnIssue,
  };
  const argv = ['rag-ops', action];
  pushOptional(argv, '--platform', platform);
  pushOptional(argv, '--job-key', jobKey);
  pushOptional(argv, '--keyword', keyword);
  pushOptional(argv, '--question', question);
  pushOptional(argv, '--file', file);
  pushOptional(argv, '--policy', policyFile);
  pushOptional(argv, '--reviewer', reviewer);
  if (limit !== undefined) {
    argv.push('--limit', String(limit));
  }
  pushOptionalBoolean(argv, '--include-reviewed', includeReviewed);
  pushOptionalBoolean(argv, '--fail-on-issue', failOnIssue);

  return {
    input,
    argv,
    inputSummary: {
      action,
      platform,
      jobKey,
      keyword,
      question,
      file,
      policyFile,
      reviewer,
      limit,
      includeReviewed: includeReviewed ?? false,
      failOnIssue: failOnIssue ?? false,
    },
  };
}

function normalizeRagJobKey(item: JsonObject): string {
  const jobKey = getOptionalString(item, 'jobKey');
  if (jobKey) {
    return jobKey;
  }

  const keyword = getOptionalString(item, 'keyword');
  if (keyword) {
    return buildJobKey(keyword, '');
  }

  throw new Error('jobKey or keyword is required');
}

function normalizeRole(value: unknown, fieldPath: string): RagSpeaker {
  if (value === 'candidate' || value === 'recruiter' || value === 'system') {
    return value;
  }

  throw new Error(`${fieldPath}.role must be candidate, recruiter, or system`);
}

function normalizeConversationTurn(value: unknown, index: number): RagConversationTurn {
  const item = normalizeJsonObject(value, `turns[${index}]`);
  return {
    id: getOptionalString(item, 'id'),
    role: normalizeRole(item.role, `turns[${index}]`),
    content: getRequiredString(item, 'content'),
    verified: item.verified === true,
    createdAt: getOptionalString(item, 'createdAt'),
    metadata: getOptionalMetadata(item, 'metadata'),
  };
}

function normalizeConversationTurns(value: unknown): RagConversationTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('turns must be a non-empty array');
  }

  return value.map((turn, index) => normalizeConversationTurn(turn, index));
}

export function normalizeRagAnswerRequest(payload: unknown): NormalizedRagAnswerRequest {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  const question = getRequiredString(item, 'question');
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');
  const keyword = getOptionalString(item, 'keyword');
  const jobKey = getOptionalString(item, 'jobKey') ?? (keyword ? buildJobKey(keyword, '') : undefined);

  if (jd || jdFile) {
    if (jd && jdFile) {
      throw new Error('jd and jdFile are mutually exclusive');
    }

    return {
      mode: 'temporary-jd',
      platform,
      jobKey,
      question,
      jd,
      jdFile,
    };
  }

  return {
    mode: 'stored',
    options: {
      platform,
      jobKey: normalizeRagJobKey(item),
      question,
      topK: getOptionalPositiveInteger(item, 'topK'),
      autoIndex: getOptionalBoolean(item, 'autoIndex'),
      logAnswer: getOptionalBoolean(item, 'logAnswer'),
      answerLogMetadata: getOptionalMetadata(item, 'metadata'),
    },
  };
}

export function normalizeRagAnswerInput(payload: unknown): RagAnswerInput {
  const item = normalizeJsonObject(payload, 'request body');
  const platform = normalizePlatform(item.platform);
  const question = getRequiredString(item, 'question');
  const jd = getOptionalString(item, 'jd');
  const jdFile = getOptionalString(item, 'jdFile');

  if (jd && jdFile) {
    throw new Error('jd and jdFile are mutually exclusive');
  }

  return {
    platform,
    jobKey: getOptionalString(item, 'jobKey'),
    keyword: getOptionalString(item, 'keyword'),
    jd,
    jdFile,
    question,
    topK: getOptionalPositiveInteger(item, 'topK'),
    autoIndex: getOptionalBoolean(item, 'autoIndex'),
    logAnswer: getOptionalBoolean(item, 'logAnswer'),
    metadata: getOptionalMetadata(item, 'metadata'),
  };
}

export function normalizeApplicationFilterInputRequest(payload: unknown): {
  platform: SupportedPlatform;
  applicationFilterInput: Record<string, unknown>;
  label?: string;
} {
  const item = normalizeJsonObject(payload, 'request body');
  const applicationFilterInput = item.applicationFilterInput;
  if (!applicationFilterInput || typeof applicationFilterInput !== 'object' || Array.isArray(applicationFilterInput)) {
    throw new Error('applicationFilterInput must be a JSON object');
  }

  return {
    platform: normalizePlatform(item.platform),
    applicationFilterInput: applicationFilterInput as Record<string, unknown>,
    label: getOptionalString(item, 'label'),
  };
}

export function normalizeConversationRequest(payload: unknown): IngestConversationOptions {
  const item = normalizeJsonObject(payload, 'request body');
  return {
    platform: normalizePlatform(item.platform),
    jobKey: normalizeRagJobKey(item),
    conversationId: getRequiredString(item, 'conversationId'),
    turns: normalizeConversationTurns(item.turns),
  };
}
