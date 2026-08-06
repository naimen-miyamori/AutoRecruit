import { z } from 'zod';
import { completeJsonTextFromOpenAI, type OpenAISettingsOverride, type OpenAITextCompletionRequest } from '../llm/openai-client.js';
import {
  normalizeBatchTask,
  normalizeBossAutoChatTask,
  normalizeBossChatOperationTask,
  normalizeBossGreetTask,
  normalizeBossJobSyncTask,
  normalizeBossTalentSearchTask,
  normalizeLoginRefreshTask,
  normalizeRagAnswerInput,
  normalizeRagOpsTask,
  normalizeResumeCaptureTask,
  normalizeSearchSubscriptionTask,
  normalizeTalentMappingTask,
} from './task-normalizers.js';
import {
  assistantModeIds,
  assertAssistantModeMatchesKind,
  compileAssistantModeInput,
  getAssistantModeDefinition,
  inferAssistantModeId,
  isAssistantModeId,
  listAssistantModeDefinitions,
  type AssistantModeId,
  type AssistantModeTaskKind,
} from './assistant-mode-registry.js';
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantDraft,
  AssistantMessage,
  BatchTaskInput,
  BossAutoChatTaskInput,
  BossChatOperationTaskInput,
  BossGreetTaskInput,
  BossJobSyncTaskInput,
  BossTalentSearchTaskInput,
  LoginRefreshTaskInput,
  ModelConfig,
  RagAnswerInput,
  RagOpsTaskInput,
  ResumeCaptureTaskInput,
  SearchSubscriptionTaskInput,
  TalentMappingTaskInput,
} from './types.js';

export type AssistantCompletion = (request: OpenAITextCompletionRequest) => Promise<string>;

const objectSchema = z.object({}).catchall(z.unknown());
const assistantKindSchema = z.enum([
  'resume-capture',
  'batch',
  'talent-mapping',
  'search-subscription',
  'boss-auto-chat',
  'boss-talent-search',
  'boss-greet',
  'boss-chat-operation',
  'boss-job-sync',
  'login-refresh',
  'rag-ops',
  'rag-answer',
]);
const assistantModeIdSchema = z.enum(assistantModeIds);

const modelDraftSchema = z.object({
  modeId: assistantModeIdSchema.optional(),
  kind: assistantKindSchema.optional(),
  input: objectSchema.default({}),
  missingFields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
}).refine((draft) => draft.modeId !== undefined || draft.kind !== undefined, {
  message: 'assistant draft requires modeId or legacy kind',
});

const modelResponseSchema = z.object({
  reply: z.string().optional(),
  message: z.string().optional(),
  draft: modelDraftSchema.nullish(),
  clarificationQuestions: z.array(z.string()).default([]),
  rejected: z.boolean().default(false),
});

const assistantModelConfigSchema = z.object({
  baseUrl: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
}).partial();

const allowedInputFields: Record<AssistantDraft['kind'], string[]> = {
  'resume-capture': [
    'platform',
    'keyword',
    'bossJobId',
    'bossSearchKeyword',
    'jd',
    'jdFile',
    'includeViewed',
    'includeBoss',
    'searchSource',
    'applicationFilterInputFile',
    'searchConditionSetRefs',
    'email',
    'cc',
    'liepinForwardContact',
    'bossForwardMode',
    'bossForwardRecipient',
    'bossForwardCc',
    'bossScreeningEnabled',
    'bossScreeningPolicyFile',
    'bossSecondaryEmail',
    'bossSecondaryCc',
    'resultRoutingEnabled',
    'resultRoutingPolicyFile',
    'secondaryEmail',
    'secondaryCc',
  ],
  batch: [
    'platform',
    'jobsFile',
    'includeViewed',
    'includeBoss',
    'searchSource',
    'applicationFilterInputFile',
    'searchConditionSetRefs',
    'email',
    'cc',
    'liepinForwardContact',
    'bossForwardMode',
    'bossForwardRecipient',
    'bossForwardCc',
    'bossScreeningEnabled',
    'bossScreeningPolicyFile',
    'bossSecondaryEmail',
    'bossSecondaryCc',
    'resultRoutingEnabled',
    'resultRoutingPolicyFile',
    'secondaryEmail',
    'secondaryCc',
  ],
  'talent-mapping': [
    'platform', 'talentMappingFile', 'mappingStage', 'confirmedDetailOpen', 'mappingRunId',
  ],
  'search-subscription': [
    'platform',
    'includeBoss',
    'searchSubscriptionFile',
    'keyword',
    'applicationFilterInputFile',
    'searchConditionSetRefs',
    'saveSearchSubscription',
    'searchSubscriptionName',
  ],
  'boss-auto-chat': [
    'platform',
    'scoreThreshold',
    'requireAllHardRequirements',
    'replyToUnqualifiedCandidates',
    'bossForwardMode',
    'bossForwardRecipient',
    'bossForwardCc',
    'summaryEmail',
    'summaryCc',
    'syncJobsBeforeReview',
  ],
  'boss-talent-search': [
    'platform', 'source', 'bossJobId', 'expectedJobName', 'coreRequirements',
    'bonusRequirements', 'triggerMatch', 'confirmed',
  ],
  'boss-greet': [
    'platform', 'source', 'candidateId', 'expectedCandidateName', 'expectedJobName',
    'bossJobId', 'intentId', 'confirmed',
  ],
  'boss-chat-operation': [
    'platform', 'action', 'conversationId', 'expectedCandidateName', 'expectedJobName',
    'text', 'remark', 'intentId', 'unreadOnly', 'confirmed',
  ],
  'boss-job-sync': ['platform', 'bossJobIds', 'includeClosed'],
  'login-refresh': ['platform'],
  'rag-ops': [
    'action',
    'platform',
    'jobKey',
    'keyword',
    'question',
    'file',
    'policyFile',
    'reviewer',
    'limit',
    'includeReviewed',
    'failOnIssue',
  ],
  'rag-answer': [
    'platform',
    'jobKey',
    'keyword',
    'jd',
    'jdFile',
    'question',
    'topK',
    'autoIndex',
    'logAnswer',
    'metadata',
  ],
};

function unique(items: Array<string | undefined>): string[] {
  return [...new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
}

function coerceScalar(field: string, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if ((field === 'includeViewed' || field === 'includeBoss' || field === 'bossScreeningEnabled' || field === 'resultRoutingEnabled' || field === 'saveSearchSubscription' || field === 'includeReviewed' || field === 'failOnIssue' || field === 'autoIndex' || field === 'logAnswer' || field === 'requireAllHardRequirements' || field === 'replyToUnqualifiedCandidates' || field === 'syncJobsBeforeReview' || field === 'triggerMatch' || field === 'confirmed' || field === 'confirmedDetailOpen' || field === 'unreadOnly' || field === 'includeClosed') && typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  if ((field === 'limit' || field === 'topK' || field === 'scoreThreshold') && typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }

  if (Array.isArray(value) && (
    field === 'cc'
    || field === 'bossForwardCc'
    || field === 'bossSecondaryCc'
    || field === 'secondaryCc'
    || field === 'summaryCc'
    || field === 'coreRequirements'
    || field === 'bonusRequirements'
    || field === 'bossJobIds'
  )) {
    return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  }

  return value;
}

function cleanInput(kind: AssistantDraft['kind'], input: Record<string, unknown>): {
  input: Record<string, unknown>;
  droppedFields: string[];
} {
  const allowed = new Set(allowedInputFields[kind]);
  const cleaned: Record<string, unknown> = {};
  const droppedFields: string[] = [];

  for (const [field, rawValue] of Object.entries(input)) {
    if (!allowed.has(field)) {
      droppedFields.push(field);
      continue;
    }

    const value = coerceScalar(field, rawValue);
    if (value !== undefined && !(typeof value === 'string' && !value.trim())) {
      cleaned[field] = value;
    }
  }

  return { input: cleaned, droppedFields };
}

function computeMissingFields(kind: AssistantDraft['kind'], input: Record<string, unknown>): string[] {
  const missing: string[] = [];

  if (!isPresent(input.platform)) {
    missing.push('platform');
  }

  if (kind === 'resume-capture') {
    if (!isPresent(input.keyword)) {
      missing.push('keyword');
    }
    const reusesBossJobSettings = input.platform === 'boss' && isPresent(input.bossJobId);
    if (!reusesBossJobSettings && !isPresent(input.jd) && !isPresent(input.jdFile)) {
      missing.push('jd 或 jdFile');
    }
  }

  if ((kind === 'resume-capture' || kind === 'batch')
    && isPresent(input.bossForwardMode) !== isPresent(input.bossForwardRecipient)) {
    missing.push(isPresent(input.bossForwardMode) ? 'bossForwardRecipient' : 'bossForwardMode');
  }

  if (kind === 'resume-capture' || kind === 'batch') {
    if (Array.isArray(input.bossForwardCc) && input.bossForwardCc.length > 0 && input.bossForwardMode === 'colleague') {
      missing.push('bossForwardMode=email');
    }
  }

  if ((kind === 'resume-capture' || kind === 'batch')
    && input.platform === 'all'
    && (isPresent(input.bossForwardMode)
      || isPresent(input.bossForwardCc)
      || isPresent(input.bossScreeningEnabled)
      || isPresent(input.bossScreeningPolicyFile)
      || isPresent(input.bossSecondaryEmail)
      || isPresent(input.bossSecondaryCc))
    && input.includeBoss !== true) {
    missing.push('includeBoss');
  }

  if (kind === 'boss-auto-chat') {
    if (isPresent(input.bossForwardMode) !== isPresent(input.bossForwardRecipient)) {
      missing.push(isPresent(input.bossForwardMode) ? 'bossForwardRecipient' : 'bossForwardMode');
    }
    if (isPresent(input.summaryCc) && !isPresent(input.summaryEmail)) {
      missing.push('summaryEmail');
    }
    if (Array.isArray(input.bossForwardCc) && input.bossForwardCc.length > 0 && input.bossForwardMode === 'colleague') {
      missing.push('bossForwardMode=email');
    }
  }

  if (kind === 'boss-talent-search') {
    if (!isPresent(input.source)) missing.push('source');
    if (input.triggerMatch === true && input.confirmed !== true) missing.push('confirmed');
  }

  if (kind === 'boss-greet') {
    for (const field of ['source', 'candidateId', 'expectedCandidateName', 'expectedJobName'] as const) {
      if (!isPresent(input[field])) missing.push(field);
    }
    if (input.confirmed !== true) missing.push('confirmed');
  }

  if (kind === 'boss-chat-operation') {
    if (!isPresent(input.action)) missing.push('action');
    if (input.action !== 'list-conversations' && !isPresent(input.conversationId)) missing.push('conversationId');
    if (input.action === 'send-text' && !isPresent(input.text)) missing.push('text');
    if (input.action === 'remark' && !isPresent(input.remark)) missing.push('remark');
    const mutations = ['send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume', 'exchange-phone', 'exchange-wechat'];
    if (mutations.includes(String(input.action))) {
      if (!isPresent(input.intentId)) missing.push('intentId');
      if (input.confirmed !== true) missing.push('confirmed');
    }
  }

  if (kind === 'batch' && !isPresent(input.jobsFile)) {
    missing.push('jobsFile');
  }

  if (kind === 'talent-mapping') {
    if (!isPresent(input.talentMappingFile)) missing.push('talentMappingFile');
    if (!isPresent(input.mappingStage)) missing.push('mappingStage');
    if ((input.mappingStage === 'enrich' || input.mappingStage === 'all') && input.confirmedDetailOpen !== true) {
      missing.push('confirmedDetailOpen');
    }
  }

  if (kind === 'search-subscription' && !isPresent(input.searchSubscriptionFile)) {
    missing.push('searchSubscriptionFile');
  }

  if (kind === 'rag-ops') {
    const action = input.action;
    if (!isPresent(action)) {
      missing.push('action');
    }
    if ((action === 'doctor' || action === 'review' || action === 'rebuild') && !isPresent(input.jobKey) && !isPresent(input.keyword)) {
      missing.push('jobKey 或 keyword');
    }
    if ((action === 'metrics' || action === 'ops') && !isPresent(input.file)) {
      missing.push('file');
    }
  }

  if (kind === 'rag-answer') {
    if (!isPresent(input.question)) {
      missing.push('question');
    }
    if (!isPresent(input.jobKey) && !isPresent(input.keyword) && !isPresent(input.jd) && !isPresent(input.jdFile)) {
      missing.push('jobKey 或 keyword 或 jd/jdFile');
    }
  }

  return missing;
}

function computeWarnings(kind: AssistantDraft['kind'], input: Record<string, unknown>, droppedFields: string[]): string[] {
  const warnings: string[] = [];

  if (droppedFields.length > 0) {
    warnings.push(`已忽略不支持的字段：${droppedFields.join(', ')}`);
  }

  if (input.platform === 'all' && kind === 'search-subscription') {
    warnings.push(input.includeBoss === true
      ? '风险：订阅管理会按 51job -> 猎聘 -> 智联 -> Boss 直聘·直猎邦 Pro 顺序执行；只选择/保存平台“我的订阅”，不会抓取候选、打开详情、写 seen/评分/报告或发送邮件。'
      : '提示：订阅管理默认只按 51job -> 猎聘 -> 智联执行；不会抓取候选、打开详情、写 seen/评分/报告或发送邮件。');
  } else if (input.platform === 'all') {
    warnings.push(input.includeBoss === true
      ? '风险：全部主平台会按 51job -> 猎聘 -> 智联 -> Boss 直聘·直猎邦 Pro 顺序执行，任一平台失败会停止；Boss 阶段会打开简历详情，且可能复用已保存的转发配置。'
      : '风险：全部主平台会按 51job -> 猎聘 -> 智联顺序执行，任一平台失败会停止；未启用 includeBoss 时不会运行直猎邦。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && input.includeViewed === true) {
    warnings.push('风险：已选择包含已查看候选人，候选人范围会扩大。');
  }

  if ((kind === 'resume-capture' || kind === 'batch')
    && (input.platform === 'boss' || (input.platform === 'all' && input.includeBoss === true))) {
    warnings.push('风险：Boss 普通抓取会打开候选详情，并可能复用岗位已保存的转发、报告邮件和模型分流配置。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && (isPresent(input.email) || (Array.isArray(input.cc) && input.cc.length > 0) || isPresent(input.bossSecondaryEmail) || (Array.isArray(input.bossSecondaryCc) && input.bossSecondaryCc.length > 0))) {
    warnings.push('风险：任务完成后会发送邮件。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && isPresent(input.liepinForwardContact)) {
    warnings.push('风险：猎聘会执行简历转发动作。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && (
    isPresent(input.bossForwardMode)
    || isPresent(input.bossForwardCc)
  )) {
    warnings.push('风险：Boss 会把简历转发给指定站内同事或邮箱。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && input.bossScreeningEnabled === true) {
    warnings.push('风险：Boss 将在评分后按模型要求分流：明确满足和需复核候选人转发并报告给主受众，模型明确判断要求缺失的候选人不做 Boss 转发，而向副收件人逐份发送否定原因和完整简历。');
  }

  if (kind === 'boss-auto-chat') {
    warnings.push('风险：Boss 自动沟通审查会打开未读会话；已聊过候选人只汇总本次新回复，首次沟通候选人才会继续匹配，并按结果转发简历、发送常用语或发起换电话请求。');
    if (!isPresent(input.bossForwardMode) && !isPresent(input.bossForwardRecipient)) {
      warnings.push('配置提示：未提供 Boss 转发目标时会复用岗位或平台已保存配置；没有可用配置的会话保持未打开。');
    }
    if (input.requireAllHardRequirements === true) {
      warnings.push('风险：只有所有硬性要求都有明确简历证据时才会转发；物业电工仅在其他条件均满足且有上海就读线索时，在聊天框输入并发送上海籍确认问题，其他缺失信息按不符合处理。');
    }
    if (input.replyToUnqualifiedCandidates === true) {
      warnings.push('风险：已开启不合适候选人回复，任务会从 Boss 常用语面板发送固定拒绝消息；默认关闭。');
    }
    if (isPresent(input.summaryEmail)) {
      warnings.push('风险：任务结束后会把候选人姓名、ID和判断理由发送到总结邮箱。');
    }
    if (input.syncJobsBeforeReview === true) {
      warnings.push('执行提示：审查未读会话前会先同步 Boss 职位和 JD；任一职位同步失败会中止本轮自动沟通。');
    }
  }

  if (kind === 'boss-talent-search' && input.triggerMatch === true) {
    warnings.push('风险：立即匹配会消耗 Boss 深度搜索匹配次数。');
  }
  if (kind === 'boss-greet') {
    warnings.push('风险：会向精确 Boss 候选人发起一次打招呼，执行前会重新校验候选人和职位。');
  }
  if (kind === 'boss-chat-operation' && ['send-text', 'remark', 'mark-not-fit', 'request-attachment-resume', 'accept-attachment-resume', 'exchange-phone', 'exchange-wechat'].includes(String(input.action))) {
    warnings.push('风险：该 Boss 原子操作会修改会话状态或联系候选人，必须提供 intentId 并显式确认。');
  }

  if ((kind === 'resume-capture' || kind === 'batch')
    && (isPresent(input.applicationFilterInputFile) || isPresent(input.searchConditionSetRefs))
    && input.searchSource !== 'direct') {
    warnings.push('校验提示：applicationFilterInputFile 或 searchConditionSetRefs 只能和 searchSource=direct 一起使用。');
  }

  if (isPresent(input.applicationFilterInputFile) && isPresent(input.searchConditionSetRefs)) {
    warnings.push('校验提示：applicationFilterInputFile 和 searchConditionSetRefs 不能同时使用。');
  }

  if (kind === 'batch') {
    warnings.push('风险：批量任务会按 jobs 文件逐项执行。');
  }

  if (kind === 'talent-mapping' && (input.mappingStage === 'enrich' || input.mappingStage === 'all')) {
    warnings.push('风险：人才地图详情补全会打开候选人详情，可能改变平台已查看状态；本轮必须显式 confirmedDetailOpen=true，且不会评分、转发、联系、发邮件或写入 RAG。');
  }

  if (kind === 'search-subscription' && input.saveSearchSubscription === true) {
    warnings.push(input.includeBoss === true || input.platform === 'boss'
      ? '风险：会在 Boss“我的订阅”中创建或改名订阅；结果中的名称、关键词和完整条件指纹必须匹配后才会报告成功。'
      : '风险：订阅管理会保存到招聘平台。');
  }

  if (kind === 'rag-ops' && input.action === 'rebuild') {
    warnings.push('风险：RAG rebuild 会重建岗位向量索引。');
  }

  if (kind === 'rag-ops' && input.failOnIssue === true) {
    warnings.push('风险：failOnIssue 会在发现问题时将任务标记失败。');
  }

  return warnings;
}

function previewArgv(kind: AssistantDraft['kind'], input: Record<string, unknown>): string[] {
  try {
    switch (kind) {
      case 'resume-capture':
        return normalizeResumeCaptureTask(input).argv;
      case 'batch':
        return normalizeBatchTask(input).argv;
      case 'talent-mapping':
        return approximateArgv(kind, input);
      case 'search-subscription':
        return normalizeSearchSubscriptionTask(input).argv;
      case 'boss-auto-chat':
        return normalizeBossAutoChatTask(input).argv;
      case 'boss-talent-search':
        return normalizeBossTalentSearchTask(input).argv;
      case 'boss-greet':
        return normalizeBossGreetTask(input).argv;
      case 'boss-chat-operation':
        return normalizeBossChatOperationTask(input).argv;
      case 'boss-job-sync':
        return normalizeBossJobSyncTask(input).argv;
      case 'login-refresh':
        return normalizeLoginRefreshTask(input).argv;
      case 'rag-ops':
        return normalizeRagOpsTask(input).argv;
      case 'rag-answer':
        normalizeRagAnswerInput(input);
        return [];
    }
  } catch {
    return approximateArgv(kind, input);
  }
}

function pushPreview(argv: string[], flag: string, value: unknown): void {
  if (isPresent(value)) {
    argv.push(flag, String(value));
  }
}

function pushBooleanPreview(argv: string[], flag: string, value: unknown): void {
  if (typeof value === 'boolean') {
    argv.push(flag, String(value));
  }
}

function previewSearchConditionSetRefs(value: unknown, platform: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([platformKey, reference]) => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        return [];
      }
      const item = reference as Record<string, unknown>;
      if (typeof item.conditionSetId !== 'string' || !item.conditionSetId.trim()
        || typeof item.revision !== 'number' || !Number.isInteger(item.revision) || item.revision <= 0) {
        return [];
      }
      return [{ platformKey, conditionSetId: item.conditionSetId.trim(), revision: item.revision }];
    });
  if (entries.length === 0) {
    return undefined;
  }

  if (typeof platform === 'string' && platform !== 'all') {
    const reference = entries.find((entry) => entry.platformKey === platform);
    return reference ? `${reference.conditionSetId}@${reference.revision}` : undefined;
  }

  return entries.map((entry) => `${entry.platformKey}=${entry.conditionSetId}@${entry.revision}`).join(',');
}

function approximateArgv(kind: AssistantDraft['kind'], input: Record<string, unknown>): string[] {
  if (kind === 'rag-answer') {
    return [];
  }

  if (kind === 'rag-ops') {
    const argv = ['rag-ops'];
    pushPreview(argv, '', input.action);
    pushPreview(argv, '--platform', input.platform);
    pushPreview(argv, '--job-key', input.jobKey);
    pushPreview(argv, '--keyword', input.keyword);
    pushPreview(argv, '--question', input.question);
    pushPreview(argv, '--file', input.file);
    pushPreview(argv, '--policy', input.policyFile);
    pushPreview(argv, '--reviewer', input.reviewer);
    pushPreview(argv, '--limit', input.limit);
    pushBooleanPreview(argv, '--include-reviewed', input.includeReviewed);
    pushBooleanPreview(argv, '--fail-on-issue', input.failOnIssue);
    return argv.filter((item) => item !== '');
  }

  if (kind === 'login-refresh') {
    return [];
  }

  if (kind === 'boss-auto-chat') {
    const argv = ['--platform', String(input.platform ?? ''), '--boss-auto-chat', 'true'];
    pushPreview(argv, '--boss-chat-score-threshold', input.scoreThreshold);
    pushBooleanPreview(argv, '--boss-chat-require-all', input.requireAllHardRequirements);
    pushBooleanPreview(argv, '--boss-chat-reply-unqualified', input.replyToUnqualifiedCandidates);
    pushPreview(argv, '--boss-forward-mode', input.bossForwardMode);
    pushPreview(argv, '--boss-forward-recipient', input.bossForwardRecipient);
    pushPreview(argv, '--boss-forward-cc', Array.isArray(input.bossForwardCc) ? input.bossForwardCc.join(',') : input.bossForwardCc);
    pushPreview(argv, '--boss-chat-summary-email', input.summaryEmail);
    pushPreview(argv, '--boss-chat-summary-cc', Array.isArray(input.summaryCc) ? input.summaryCc.join(',') : input.summaryCc);
    pushBooleanPreview(argv, '--boss-sync-jobs-before-review', input.syncJobsBeforeReview);
    return argv;
  }

  if (kind === 'boss-talent-search') {
    const argv = ['--platform', String(input.platform ?? ''), '--boss-talent-source', String(input.source ?? '')];
    pushPreview(argv, '--boss-job-id', input.bossJobId);
    pushPreview(argv, '--boss-expected-job-name', input.expectedJobName);
    pushPreview(argv, '--boss-core-requirements-json', Array.isArray(input.coreRequirements) ? JSON.stringify(input.coreRequirements) : undefined);
    pushPreview(argv, '--boss-bonus-requirements-json', Array.isArray(input.bonusRequirements) ? JSON.stringify(input.bonusRequirements) : undefined);
    pushBooleanPreview(argv, '--boss-trigger-match', input.triggerMatch);
    pushBooleanPreview(argv, '--boss-confirmed', input.confirmed);
    return argv;
  }

  if (kind === 'boss-greet') {
    const argv = ['--platform', String(input.platform ?? '')];
    pushPreview(argv, '--boss-greet-source', input.source);
    pushPreview(argv, '--boss-greet-candidate-id', input.candidateId);
    pushPreview(argv, '--boss-expected-candidate-name', input.expectedCandidateName);
    pushPreview(argv, '--boss-expected-job-name', input.expectedJobName);
    pushPreview(argv, '--boss-job-id', input.bossJobId);
    pushPreview(argv, '--boss-intent-id', input.intentId);
    pushBooleanPreview(argv, '--boss-confirmed', input.confirmed);
    return argv;
  }

  if (kind === 'boss-chat-operation') {
    const argv = ['--platform', String(input.platform ?? '')];
    pushPreview(argv, '--boss-chat-operation', input.action);
    pushPreview(argv, '--boss-conversation-id', input.conversationId);
    pushPreview(argv, '--boss-expected-candidate-name', input.expectedCandidateName);
    pushPreview(argv, '--boss-expected-job-name', input.expectedJobName);
    pushPreview(argv, '--boss-chat-text', input.text);
    pushPreview(argv, '--boss-chat-remark', input.remark);
    pushPreview(argv, '--boss-intent-id', input.intentId);
    pushBooleanPreview(argv, '--boss-unread-only', input.unreadOnly);
    pushBooleanPreview(argv, '--boss-confirmed', input.confirmed);
    return argv;
  }

  if (kind === 'boss-job-sync') {
    const argv = ['--platform', String(input.platform ?? ''), '--boss-job-sync', 'true'];
    pushPreview(argv, '--boss-job-ids', Array.isArray(input.bossJobIds) ? input.bossJobIds.join(',') : input.bossJobIds);
    pushBooleanPreview(argv, '--boss-include-closed-jobs', input.includeClosed);
    return argv;
  }

  const argv = ['--platform', String(input.platform ?? '')].filter(Boolean);
  if (kind === 'resume-capture') {
    pushPreview(argv, '--keyword', input.keyword);
    pushPreview(argv, '--boss-job-id', input.bossJobId);
    pushPreview(argv, '--boss-search-keyword', input.bossSearchKeyword);
    pushPreview(argv, '--jd', input.jd);
    pushPreview(argv, '--jd-file', input.jdFile);
  }
  if (kind === 'batch') {
    pushPreview(argv, '--jobs-file', input.jobsFile);
  }
  if (kind === 'talent-mapping') {
    const argv = ['--platform', String(input.platform ?? ''), '--talent-mapping-file', String(input.talentMappingFile ?? ''), '--mapping-stage', String(input.mappingStage ?? '')];
    pushBooleanPreview(argv, '--mapping-confirm-detail-open', input.confirmedDetailOpen);
    pushPreview(argv, '--mapping-run-id', input.mappingRunId);
    return argv;
  }
  if (kind === 'search-subscription') {
    pushPreview(argv, '--search-subscription-file', input.searchSubscriptionFile);
    pushBooleanPreview(argv, '--include-boss', input.includeBoss);
    pushPreview(argv, '--keyword', input.keyword);
    pushPreview(argv, '--search-condition-set', previewSearchConditionSetRefs(input.searchConditionSetRefs, input.platform));
    pushBooleanPreview(argv, '--save-search-subscription', input.saveSearchSubscription);
    pushPreview(argv, '--search-subscription-name', input.searchSubscriptionName);
    return argv;
  }

  pushBooleanPreview(argv, '--include-viewed', input.includeViewed);
  pushBooleanPreview(argv, '--include-boss', input.includeBoss);
  pushPreview(argv, '--search-source', input.searchSource);
  pushPreview(argv, '--application-filter-input-file', input.applicationFilterInputFile);
  pushPreview(argv, '--search-condition-set', previewSearchConditionSetRefs(input.searchConditionSetRefs, input.platform));
  pushPreview(argv, '--email', input.email);
  pushPreview(argv, '--cc', Array.isArray(input.cc) ? input.cc.join(',') : input.cc);
  pushPreview(argv, '--liepin-forward-contact', input.liepinForwardContact);
  pushPreview(argv, '--boss-forward-mode', input.bossForwardMode);
  pushPreview(argv, '--boss-forward-recipient', input.bossForwardRecipient);
  pushPreview(argv, '--boss-forward-cc', Array.isArray(input.bossForwardCc) ? input.bossForwardCc.join(',') : input.bossForwardCc);
  pushBooleanPreview(argv, '--boss-screening-enabled', input.bossScreeningEnabled);
  pushPreview(argv, '--boss-screening-policy-file', input.bossScreeningPolicyFile);
  pushPreview(argv, '--boss-secondary-email', input.bossSecondaryEmail);
  pushPreview(argv, '--boss-secondary-cc', Array.isArray(input.bossSecondaryCc) ? input.bossSecondaryCc.join(',') : input.bossSecondaryCc);
  return argv;
}

interface RawAssistantDraft {
  modeId?: AssistantModeId;
  kind?: AssistantDraft['kind'];
  input?: Record<string, unknown>;
  missingFields?: string[];
  warnings?: string[];
}

function compileRawAssistantDraft(rawDraft: RawAssistantDraft): {
  modeId: AssistantModeId;
  kind: AssistantModeTaskKind;
  input: Record<string, unknown>;
  label: string;
  effectSummary: string;
} {
  const rawInput = rawDraft.input ?? {};
  const modeId = rawDraft.modeId ?? (
    rawDraft.kind
      ? inferAssistantModeId(rawDraft.kind as AssistantModeTaskKind, rawInput)
      : undefined
  );
  if (!modeId || !isAssistantModeId(modeId)) {
    throw new Error('assistant-mode-unknown: draft requires a registered modeId or legacy kind');
  }

  const definition = getAssistantModeDefinition(modeId);
  if (rawDraft.kind) {
    assertAssistantModeMatchesKind(modeId, rawDraft.kind as AssistantModeTaskKind);
  }
  if (rawInput.searchSource !== undefined) {
    const expectedSource = definition.searchSource;
    const batchSearchSourceIsAllowed = definition.modeId === 'batch.capture';
    if (!batchSearchSourceIsAllowed
      && (expectedSource === undefined || expectedSource === 'reuse-job-settings' || rawInput.searchSource !== expectedSource)) {
      throw new Error(`assistant-mode-conflict: ${modeId} cannot carry searchSource=${String(rawInput.searchSource)}`);
    }
  }

  const compiled = compileAssistantModeInput(modeId, rawInput);
  return {
    modeId,
    kind: compiled.kind,
    input: compiled.input,
    label: compiled.definition.label,
    effectSummary: compiled.definition.effectSummary,
  };
}

export function finalizeAssistantDraft(rawDraft: RawAssistantDraft): AssistantDraft {
  const compiled = compileRawAssistantDraft(rawDraft);
  const { input, droppedFields } = cleanInput(compiled.kind, compiled.input);
  const missingFields = computeMissingFields(compiled.kind, input);
  const warnings = unique([
    ...(rawDraft.warnings ?? []),
    ...computeWarnings(compiled.kind, input, droppedFields),
  ]);

  if (compiled.kind === 'rag-answer') {
    return {
      modeId: compiled.modeId,
      modeLabel: compiled.label,
      effectSummary: compiled.effectSummary,
      kind: compiled.kind,
      input: input as Partial<RagAnswerInput> & Record<string, unknown>,
      missingFields,
      warnings,
    };
  }

  return {
    modeId: compiled.modeId,
    modeLabel: compiled.label,
    effectSummary: compiled.effectSummary,
    kind: compiled.kind,
    input: input as Partial<ResumeCaptureTaskInput | BatchTaskInput | TalentMappingTaskInput | SearchSubscriptionTaskInput | BossAutoChatTaskInput | BossTalentSearchTaskInput | BossGreetTaskInput | BossChatOperationTaskInput | BossJobSyncTaskInput | LoginRefreshTaskInput | RagOpsTaskInput> & Record<string, unknown>,
    missingFields,
    warnings,
    argvPreview: previewArgv(compiled.kind, input),
  } as AssistantDraft;
}

export function assistantDraftRequiresRiskAcceptance(draft: AssistantDraft): boolean {
  return draft.warnings.some((warning) => warning.startsWith('风险：'));
}

export function validateAssistantDraft(draft: AssistantDraft): AssistantChatResponse {
  const finalized = finalizeAssistantDraft(draft);
  return {
    message: {
      role: 'assistant',
      content: finalized.missingFields.length > 0
        ? '草稿已重新校验，请补充缺失字段后再确认执行。'
        : '草稿已重新校验，可以确认执行。',
      createdAt: new Date().toISOString(),
    },
    draft: finalized,
    clarificationQuestions: finalized.missingFields.map((field) => `请补充 ${field}。`),
  };
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('assistant model returned empty text content');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      return JSON.parse(fencedMatch[1].trim()) as unknown;
    }
  }

  throw new Error('assistant model did not return parseable JSON text');
}

function latestUserText(messages: AssistantMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function isUnsafeShellRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(rm\s+-rf|git\s+reset|sudo\b|chmod\b|chown\b|curl\b|bash\b|zsh\b|sh\s+-c|python\b|node\b|npm\b|pnpm\b|yarn\b|npx\b)\b/i.test(text)
    || /(shell|终端|系统命令|命令行|删除文件|重置仓库|任意命令)/u.test(text)
    || /执行.*(命令|rm|git|npm|node|python|curl|bash|脚本)/u.test(normalized)
  );
}

function buildSystemPrompt(): string {
  const modeCatalog = listAssistantModeDefinitions()
    .map((definition) => `${definition.modeId}=${definition.label}（${definition.effectSummary}；别名：${definition.aliases.join('、')}）`)
    .join('\n');
  return [
    '你是招聘自动化 CLI 助手，只能把中文需求转换成受控任务草稿 JSON。',
    '绝对禁止输出 shell 命令、npm script、文件写入动作、破坏性命令或任何绕过后端 normalizer 的参数。',
    `只能选择以下一个 modeId，不能自行创造模式：\n${modeCatalog}`,
    'kind 是服务端根据 modeId 派生的兼容字段；优先只输出 modeId，不要自行组合 kind 和 searchSource。',
    '输出必须是严格 JSON 对象，不要 markdown，不要代码块，不要解释。',
    'JSON 结构：{"reply":"中文回复","draft":{"modeId":"...","input":{...},"missingFields":[],"warnings":[]},"clarificationQuestions":[],"rejected":false}',
    'resume-capture 模式字段：platform, keyword, bossJobId, bossSearchKeyword, jd, jdFile, includeViewed, includeBoss, applicationFilterInputFile, searchConditionSetRefs, email, cc, liepinForwardContact, bossForwardMode, bossForwardRecipient, bossForwardCc, bossScreeningEnabled, bossScreeningPolicyFile, bossSecondaryEmail, bossSecondaryCc。不要自行输出 searchSource；订阅搜索、直接搜索和复用岗位设置由 modeId 决定。bossJobId 只用于 platform=boss 或 all 且 includeBoss=true 的普通抓取，必须是精确的已同步职位 ID；bossSearchKeyword 只覆盖 Boss 人才页查询词，不改变岗位身份或其他平台关键词。只要 platform=boss 且提供 bossJobId，就可复用岗位已保存 JD/搜索设置而省略 jd 和 jdFile。searchConditionSetRefs 是 {平台:{conditionSetId,platform,revision}}，revision 必须固定。',
    'batch 字段：platform, jobsFile, includeViewed, includeBoss, searchSource, applicationFilterInputFile, searchConditionSetRefs, email, cc, liepinForwardContact, bossForwardMode, bossForwardRecipient, bossForwardCc, bossScreeningEnabled, bossScreeningPolicyFile, bossSecondaryEmail, bossSecondaryCc；不要包含 keyword、jd、jdFile。',
    'talent-mapping 字段：platform, talentMappingFile, mappingStage, confirmedDetailOpen, mappingRunId；mappingStage 只能 scan、enrich、all，详情阶段必须 confirmedDetailOpen=true；只允许 51job、liepin、zhilian 或 all，不允许 Boss；不与普通抓取、JD、邮件、转发、订阅或 RAG 参数组合。',
    'Boss 转发和评分后模型要求分流仅允许 platform=boss，或 platform=all 且 includeBoss=true；bossForwardMode 只能是 colleague 或 email，出现时必须与 recipient 同时提供。bossScreeningPolicyFile 只引用版本 2 模型要求 JSON，不接受旧版本、脚本、表达式或收件人；bossScreeningEnabled=true 时，明确满足和需复核候选人转发给主受众，模型明确判断要求缺失的候选人不做 Boss 转发，而向 bossSecondaryEmail 逐份发送否定原因和完整简历。',
    'boss-auto-chat 字段：platform, scoreThreshold, requireAllHardRequirements, replyToUnqualifiedCandidates, bossForwardMode, bossForwardRecipient, bossForwardCc, summaryEmail, summaryCc, syncJobsBeforeReview；platform 必须是 boss。replyToUnqualifiedCandidates 默认 false，仅显式设为 true 时才向不合适候选人发送固定拒绝常用语。转发和总结邮件参数可省略以复用已保存配置；syncJobsBeforeReview 默认 false。',
    'boss-talent-search 字段：platform, source, bossJobId, expectedJobName, coreRequirements, bonusRequirements, triggerMatch, confirmed；source 只能 recommend 或 deep-search。triggerMatch 默认 false，设为 true 时 confirmed 必须为 true。',
    'boss-greet 字段：platform, source, candidateId, expectedCandidateName, expectedJobName, bossJobId, intentId, confirmed；必须提供精确候选人 ID、预期姓名、预期职位，confirmed 必须为 true。',
    'boss-chat-operation 字段：platform, action, conversationId, expectedCandidateName, expectedJobName, text, remark, intentId, unreadOnly, confirmed。只读 action 为 list-conversations、open-conversation、read-conversation、read-history、preview-resume；变更 action 为 send-text、remark、mark-not-fit、request-attachment-resume、accept-attachment-resume、exchange-phone、exchange-wechat，变更操作必须提供 intentId 且 confirmed=true。',
    'boss-job-sync 字段：platform, bossJobIds, includeClosed；默认同步全部职位并包含已关闭职位。',
    'search-subscription（用户界面名称“订阅管理”）字段：platform, includeBoss, searchSubscriptionFile, keyword, applicationFilterInputFile, searchConditionSetRefs, saveSearchSubscription, searchSubscriptionName；includeBoss 只可在 platform=all 时为 true，启用后按 51job、猎聘、智联、Boss 顺序执行；只选择/保存“我的订阅”，不会抓取候选、打开详情、写 seen/评分/报告或发送邮件；不要包含 jd、email、includeViewed、searchSource。',
    'login-refresh 字段：platform，只允许 51job、liepin、zhilian、boss。',
    'rag-ops 字段：action, platform, jobKey, keyword, question, file, policyFile, reviewer, limit, includeReviewed, failOnIssue；action 只能是 doctor、review、metrics、ops、rebuild。',
    'rag-answer 字段：platform, jobKey, keyword, jd, jdFile, question, topK, autoIndex, logAnswer, metadata。',
    '平台只能是 51job、liepin、zhilian、boss、all；普通抓取或批量任务的 all 在 includeBoss=true 时按 51job、liepin、zhilian、boss 执行，否则仍是前三个平台。其他模式的 all 不包含 boss；rag-answer 和 login-refresh 不能使用 all。',
    'applicationFilterInputFile 只能用于 direct 普通简历抓取或批量任务，订阅管理只作为订阅包装输入。searchConditionSetRefs 和 applicationFilterInputFile 不能同时使用；直接搜索使用筛选条件时由 modeId=capture.direct-search 表达。平台映射不得超出任务实际选择的平台。用户可见名称固定为：订阅搜索、直接搜索、订阅管理。',
    '精确术语映射不可混用：用户说“订阅搜索”只能选 capture.subscription-search；说“直接搜索”只能选 capture.direct-search；说“订阅管理”只能选 subscription.manage。若同一请求同时出现多个模式术语，返回 clarificationQuestions，不生成可执行 draft。',
    '如果信息不足，把字段名放到 missingFields，并用 clarificationQuestions 给出中文追问。',
  ].join('\n');
}

function buildModelInput(request: AssistantChatRequest): string {
  return JSON.stringify({
    messages: request.messages,
    currentDraft: request.draft,
  }, null, 2);
}

const EXPLICIT_MODE_TERMS: readonly { term: string; modeId: AssistantModeId }[] = [
  { term: '订阅搜索', modeId: 'capture.subscription-search' },
  { term: '直接搜索', modeId: 'capture.direct-search' },
  { term: '订阅管理', modeId: 'subscription.manage' },
];

function explicitModeConstraint(text: string):
  | { modeId?: AssistantModeId; conflict?: string }
  | undefined {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '');
  const matches = EXPLICIT_MODE_TERMS.filter((item) => normalized.includes(item.term));
  const modeIds = [...new Set(matches.map((item) => item.modeId))];
  if (modeIds.length === 0) return undefined;
  if (modeIds.length > 1) {
    return { conflict: `assistant-mode-ambiguous: ${modeIds.join(', ')}` };
  }
  return { modeId: modeIds[0] };
}

function assistantModeClarification(
  message: string,
  question = '请明确选择“订阅搜索”“直接搜索”或“订阅管理”中的一个模式。',
): AssistantChatResponse {
  return {
    message: {
      role: 'assistant',
      content: message,
      createdAt: new Date().toISOString(),
    },
    clarificationQuestions: [question],
    rejected: false,
  };
}

export function normalizeModelConfig(value: ModelConfig | undefined): OpenAISettingsOverride | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = assistantModelConfigSchema.parse(value);
  const config: OpenAISettingsOverride = {};
  if (parsed.baseUrl) {
    config.baseUrl = parsed.baseUrl;
  }
  if (parsed.model) {
    config.model = parsed.model;
  }
  if (parsed.apiKey) {
    config.apiKey = parsed.apiKey;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export async function chatWithCliAssistant(
  request: AssistantChatRequest,
  options: { completeJsonText?: AssistantCompletion } = {},
): Promise<AssistantChatResponse> {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const unsafeText = latestUserText(request.messages);
  if (isUnsafeShellRequest(unsafeText)) {
    return {
      message: {
        role: 'assistant',
      content: '我不能生成或执行任意 shell 命令。请描述要执行的受控招聘任务，例如简历抓取、订阅管理、登录刷新或 RAG 问答。',
        createdAt: new Date().toISOString(),
      },
      clarificationQuestions: ['请改用受控功能描述你的目标，例如“刷新智联登录”或“用 JD 执行全部平台搜索”。'],
      rejected: true,
    };
  }

  const complete = options.completeJsonText ?? completeJsonTextFromOpenAI;
  const rawText = await complete({
    featureName: 'CLI assistant',
    modelEnvName: 'OPENAI_MODEL',
    instructions: buildSystemPrompt(),
    input: buildModelInput(request),
    maxOutputTokens: 1800,
    settings: normalizeModelConfig(request.modelConfig),
  });

  let parsed: z.infer<typeof modelResponseSchema>;
  try {
    parsed = modelResponseSchema.parse(extractJsonObject(rawText));
  } catch (error) {
    const unknownMode = error instanceof z.ZodError
      && error.issues.some((issue) => issue.path[0] === 'draft' && issue.path[1] === 'modeId');
    if (unknownMode) {
      return assistantModeClarification(
        'assistant-mode-unknown: 模型返回了未注册的业务模式，本次没有生成可执行草稿。',
        '请重新确认要执行的业务模式。',
      );
    }
    throw error;
  }
  let draft: AssistantDraft | undefined;
  if (parsed.draft) {
    try {
      draft = finalizeAssistantDraft(parsed.draft);
    } catch (error) {
      return assistantModeClarification(error instanceof Error ? error.message : String(error));
    }
    const constraint = explicitModeConstraint(unsafeText);
    if (constraint?.conflict) {
      return assistantModeClarification(constraint.conflict);
    }
    if (constraint?.modeId && draft.modeId !== constraint.modeId) {
      return assistantModeClarification(
        `assistant-mode-conflict: 用户明确要求 ${constraint.modeId}，模型返回了 ${draft.modeId ?? 'unknown'}`,
      );
    }
  }
  const clarificationQuestions = unique([
    ...parsed.clarificationQuestions,
    ...(draft?.missingFields ?? []).map((field) => `请补充 ${field}。`),
  ]);
  const content = parsed.reply ?? parsed.message ?? (
    draft
      ? draft.missingFields.length > 0
        ? '我已生成任务草稿，但还需要补充信息后才能确认执行。'
        : '我已生成可确认执行的任务草稿。'
      : '请补充你想执行的招聘自动化操作。'
  );

  return {
    message: {
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
    },
    draft,
    clarificationQuestions,
    rejected: parsed.rejected,
  };
}
