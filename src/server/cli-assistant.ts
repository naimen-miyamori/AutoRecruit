import { z } from 'zod';
import { completeJsonTextFromOpenAI, type OpenAITextCompletionRequest } from '../llm/openai-client.js';
import {
  normalizeBatchTask,
  normalizeLoginRefreshTask,
  normalizeRagAnswerInput,
  normalizeRagOpsTask,
  normalizeResumeCaptureTask,
  normalizeSearchSubscriptionTask,
} from './task-normalizers.js';
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  AssistantDraft,
  AssistantMessage,
  BatchTaskInput,
  LoginRefreshTaskInput,
  RagAnswerInput,
  RagOpsTaskInput,
  ResumeCaptureTaskInput,
  SearchSubscriptionTaskInput,
} from './types.js';

export type AssistantCompletion = (request: OpenAITextCompletionRequest) => Promise<string>;

const objectSchema = z.object({}).catchall(z.unknown());
const assistantKindSchema = z.enum([
  'resume-capture',
  'batch',
  'search-subscription',
  'login-refresh',
  'rag-ops',
  'rag-answer',
]);

const modelDraftSchema = z.object({
  kind: assistantKindSchema,
  input: objectSchema.default({}),
  missingFields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

const modelResponseSchema = z.object({
  reply: z.string().optional(),
  message: z.string().optional(),
  draft: modelDraftSchema.nullish(),
  clarificationQuestions: z.array(z.string()).default([]),
  rejected: z.boolean().default(false),
});

const allowedInputFields: Record<AssistantDraft['kind'], string[]> = {
  'resume-capture': [
    'platform',
    'keyword',
    'jd',
    'jdFile',
    'includeViewed',
    'searchSource',
    'applicationFilterInputFile',
    'email',
    'cc',
    'liepinForwardContact',
  ],
  batch: [
    'platform',
    'jobsFile',
    'includeViewed',
    'searchSource',
    'applicationFilterInputFile',
    'email',
    'cc',
    'liepinForwardContact',
  ],
  'search-subscription': [
    'platform',
    'searchSubscriptionFile',
    'keyword',
    'applicationFilterInputFile',
    'saveSearchSubscription',
    'searchSubscriptionName',
  ],
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

  if ((field === 'includeViewed' || field === 'saveSearchSubscription' || field === 'includeReviewed' || field === 'failOnIssue' || field === 'autoIndex' || field === 'logAnswer') && typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  if ((field === 'limit' || field === 'topK') && typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }

  if (Array.isArray(value) && field === 'cc') {
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
    if (!isPresent(input.jd) && !isPresent(input.jdFile)) {
      missing.push('jd 或 jdFile');
    }
  }

  if (kind === 'batch' && !isPresent(input.jobsFile)) {
    missing.push('jobsFile');
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

  if (input.platform === 'all') {
    warnings.push('风险：全部平台会按 51job -> 猎聘 -> 智联顺序执行，任一平台失败会停止。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && input.includeViewed === true) {
    warnings.push('风险：已选择包含已查看候选人，候选人范围会扩大。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && (isPresent(input.email) || (Array.isArray(input.cc) && input.cc.length > 0))) {
    warnings.push('风险：任务完成后会发送邮件。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && isPresent(input.liepinForwardContact)) {
    warnings.push('风险：猎聘会执行简历转发动作。');
  }

  if ((kind === 'resume-capture' || kind === 'batch') && isPresent(input.applicationFilterInputFile) && input.searchSource !== 'direct') {
    warnings.push('校验提示：applicationFilterInputFile 只能和 searchSource=direct 一起使用。');
  }

  if (kind === 'batch') {
    warnings.push('风险：批量任务会按 jobs 文件逐项执行。');
  }

  if (kind === 'search-subscription' && input.saveSearchSubscription === true) {
    warnings.push('风险：搜索订阅会保存到招聘平台。');
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
      case 'search-subscription':
        return normalizeSearchSubscriptionTask(input).argv;
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

  const argv = ['--platform', String(input.platform ?? '')].filter(Boolean);
  if (kind === 'resume-capture') {
    pushPreview(argv, '--keyword', input.keyword);
    pushPreview(argv, '--jd', input.jd);
    pushPreview(argv, '--jd-file', input.jdFile);
  }
  if (kind === 'batch') {
    pushPreview(argv, '--jobs-file', input.jobsFile);
  }
  if (kind === 'search-subscription') {
    pushPreview(argv, '--search-subscription-file', input.searchSubscriptionFile);
    pushPreview(argv, '--keyword', input.keyword);
    pushBooleanPreview(argv, '--save-search-subscription', input.saveSearchSubscription);
    pushPreview(argv, '--search-subscription-name', input.searchSubscriptionName);
    return argv;
  }

  pushBooleanPreview(argv, '--include-viewed', input.includeViewed);
  pushPreview(argv, '--search-source', input.searchSource);
  pushPreview(argv, '--application-filter-input-file', input.applicationFilterInputFile);
  pushPreview(argv, '--email', input.email);
  pushPreview(argv, '--cc', Array.isArray(input.cc) ? input.cc.join(',') : input.cc);
  pushPreview(argv, '--liepin-forward-contact', input.liepinForwardContact);
  return argv;
}

export function finalizeAssistantDraft(rawDraft: Pick<AssistantDraft, 'kind' | 'input'> & {
  missingFields?: string[];
  warnings?: string[];
}): AssistantDraft {
  const { input, droppedFields } = cleanInput(rawDraft.kind, rawDraft.input ?? {});
  const missingFields = unique([
    ...(rawDraft.missingFields ?? []),
    ...computeMissingFields(rawDraft.kind, input),
  ]);
  const warnings = unique([
    ...(rawDraft.warnings ?? []),
    ...computeWarnings(rawDraft.kind, input, droppedFields),
  ]);

  if (rawDraft.kind === 'rag-answer') {
    return {
      kind: rawDraft.kind,
      input: input as Partial<RagAnswerInput> & Record<string, unknown>,
      missingFields,
      warnings,
    };
  }

  return {
    kind: rawDraft.kind,
    input: input as Partial<ResumeCaptureTaskInput | BatchTaskInput | SearchSubscriptionTaskInput | LoginRefreshTaskInput | RagOpsTaskInput> & Record<string, unknown>,
    missingFields,
    warnings,
    argvPreview: previewArgv(rawDraft.kind, input),
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
  return [
    '你是招聘自动化 CLI 助手，只能把中文需求转换成受控任务草稿 JSON。',
    '绝对禁止输出 shell 命令、npm script、文件写入动作、破坏性命令或任何绕过后端 normalizer 的参数。',
    '允许的 kind 只有：resume-capture、batch、search-subscription、login-refresh、rag-ops、rag-answer。',
    '输出必须是严格 JSON 对象，不要 markdown，不要代码块，不要解释。',
    'JSON 结构：{"reply":"中文回复","draft":{"kind":"...","input":{...},"missingFields":[],"warnings":[]},"clarificationQuestions":[],"rejected":false}',
    'resume-capture 字段：platform, keyword, jd, jdFile, includeViewed, searchSource, applicationFilterInputFile, email, cc, liepinForwardContact。',
    'batch 字段：platform, jobsFile, includeViewed, searchSource, applicationFilterInputFile, email, cc, liepinForwardContact；不要包含 keyword、jd、jdFile。',
    'search-subscription 字段：platform, searchSubscriptionFile, keyword, applicationFilterInputFile, saveSearchSubscription, searchSubscriptionName；不要包含 jd、email、includeViewed、searchSource。',
    'login-refresh 字段：platform，只允许 51job、liepin、zhilian。',
    'rag-ops 字段：action, platform, jobKey, keyword, question, file, policyFile, reviewer, limit, includeReviewed, failOnIssue；action 只能是 doctor、review、metrics、ops、rebuild。',
    'rag-answer 字段：platform, jobKey, keyword, jd, jdFile, question, topK, autoIndex, logAnswer, metadata。',
    '平台只能是 51job、liepin、zhilian、all；rag-answer 和 login-refresh 不能使用 all。',
    'applicationFilterInputFile 只能用于 direct 普通简历抓取或批量任务，搜索订阅只作为订阅包装输入。',
    '如果信息不足，把字段名放到 missingFields，并用 clarificationQuestions 给出中文追问。',
  ].join('\n');
}

function buildModelInput(request: AssistantChatRequest): string {
  return JSON.stringify({
    messages: request.messages,
    currentDraft: request.draft,
  }, null, 2);
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
        content: '我不能生成或执行任意 shell 命令。请描述要执行的受控招聘任务，例如简历抓取、搜索订阅、登录刷新或 RAG 问答。',
        createdAt: new Date().toISOString(),
      },
      clarificationQuestions: ['请改用受控功能描述你的目标，例如“刷新智联登录”或“用 JD 执行三平台搜索”。'],
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
  });

  const parsed = modelResponseSchema.parse(extractJsonObject(rawText));
  const draft = parsed.draft ? finalizeAssistantDraft(parsed.draft) : undefined;
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
