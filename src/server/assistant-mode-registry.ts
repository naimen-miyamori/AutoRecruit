/**
 * Stable user-facing operation modes for the console assistant.
 *
 * Task kinds and CLI flags remain compatibility/runtime concerns.  The
 * assistant emits a mode ID, and the server derives the task kind and any
 * implied search-source value from this registry.
 */

export type AssistantModeId =
  | 'capture.reuse-job-settings'
  | 'capture.subscription-search'
  | 'capture.direct-search'
  | 'batch.capture'
  | 'subscription.manage'
  | 'talent-mapping.run'
  | 'boss.auto-chat'
  | 'boss.talent-search'
  | 'boss.greet'
  | 'boss.chat-operation'
  | 'boss.job-sync'
  | 'session.login-refresh'
  | 'rag.ops'
  | 'rag.answer';

export type AssistantModeTaskKind =
  | 'resume-capture'
  | 'batch'
  | 'search-subscription'
  | 'talent-mapping'
  | 'boss-auto-chat'
  | 'boss-talent-search'
  | 'boss-greet'
  | 'boss-chat-operation'
  | 'boss-job-sync'
  | 'login-refresh'
  | 'rag-ops'
  | 'rag-answer';

export type AssistantModeSearchSource = 'saved' | 'direct' | 'reuse-job-settings' | undefined;

export interface AssistantModeDefinition {
  modeId: AssistantModeId;
  label: string;
  taskKind: AssistantModeTaskKind;
  searchSource: AssistantModeSearchSource;
  effectSummary: string;
  aliases: readonly string[];
}

const MODE_DEFINITIONS: readonly AssistantModeDefinition[] = [
  {
    modeId: 'capture.reuse-job-settings',
    label: '普通抓取（不覆盖搜索来源）',
    taskKind: 'resume-capture',
    searchSource: 'reuse-job-settings',
    effectSummary: '不显式覆盖搜索来源；已有岗位复用保存设置，新岗位沿用普通抓取默认来源。',
    aliases: ['复用岗位设置', '按岗位设置抓取'],
  },
  {
    modeId: 'capture.subscription-search',
    label: '订阅搜索',
    taskKind: 'resume-capture',
    searchSource: 'saved',
    effectSummary: '使用平台已保存的订阅入口，可能打开候选详情并执行岗位已配置的评分、转发或邮件流程。',
    aliases: ['订阅搜索', '保存的订阅搜索'],
  },
  {
    modeId: 'capture.direct-search',
    label: '直接搜索',
    taskKind: 'resume-capture',
    searchSource: 'direct',
    effectSummary: '按本次明确提供的关键词和筛选条件搜索并执行普通抓取流程。',
    aliases: ['直接搜索', '筛选搜索'],
  },
  {
    modeId: 'batch.capture',
    label: '批量抓取',
    taskKind: 'batch',
    searchSource: undefined,
    effectSummary: '按 jobs 文件逐项执行普通抓取。',
    aliases: ['批量抓取', '批量任务'],
  },
  {
    modeId: 'subscription.manage',
    label: '订阅管理',
    taskKind: 'search-subscription',
    searchSource: undefined,
    effectSummary: '只应用订阅条件、读取结果并可保存订阅，不抓取候选或评分。',
    aliases: ['订阅管理', '订阅保存', '管理订阅'],
  },
  {
    modeId: 'talent-mapping.run',
    label: '人才地图',
    taskKind: 'talent-mapping',
    searchSource: undefined,
    effectSummary: '执行独立的人才市场研究流程，不进入普通抓取状态。',
    aliases: ['人才地图', '人才研究'],
  },
  {
    modeId: 'boss.auto-chat',
    label: 'Boss 自动沟通',
    taskKind: 'boss-auto-chat',
    searchSource: undefined,
    effectSummary: '审查 Boss 未读会话并按确认的沟通策略执行。',
    aliases: ['Boss 自动沟通', 'Boss 自动聊天'],
  },
  {
    modeId: 'boss.talent-search',
    label: 'Boss 人才发现',
    taskKind: 'boss-talent-search',
    searchSource: undefined,
    effectSummary: '执行 Boss 独立人才发现；匹配动作仍需要单独确认。',
    aliases: ['Boss 人才发现', 'Boss 人才搜索', 'Boss 深度搜索'],
  },
  {
    modeId: 'boss.greet',
    label: 'Boss 打招呼',
    taskKind: 'boss-greet',
    searchSource: undefined,
    effectSummary: '向精确核验的 Boss 候选人发送一次打招呼。',
    aliases: ['Boss 打招呼', 'Boss 招呼'],
  },
  {
    modeId: 'boss.chat-operation',
    label: 'Boss 会话操作',
    taskKind: 'boss-chat-operation',
    searchSource: undefined,
    effectSummary: '读取或修改精确 Boss 会话；变更操作需要确认。',
    aliases: ['Boss 会话操作', 'Boss 聊天操作'],
  },
  {
    modeId: 'boss.job-sync',
    label: 'Boss 职位同步',
    taskKind: 'boss-job-sync',
    searchSource: undefined,
    effectSummary: '读取 Boss 职位并同步已验证的 JD 与职位身份。',
    aliases: ['Boss 职位同步', '同步 Boss 职位'],
  },
  {
    modeId: 'session.login-refresh',
    label: '登录态刷新',
    taskKind: 'login-refresh',
    searchSource: undefined,
    effectSummary: '通过平台登录流程刷新指定平台的会话状态。',
    aliases: ['登录态刷新', '刷新登录'],
  },
  {
    modeId: 'rag.ops',
    label: 'RAG 运维',
    taskKind: 'rag-ops',
    searchSource: undefined,
    effectSummary: '执行受控的 RAG 检查、审核、指标或索引操作。',
    aliases: ['RAG 运维', 'RAG 检查'],
  },
  {
    modeId: 'rag.answer',
    label: 'JD/RAG 问答',
    taskKind: 'rag-answer',
    searchSource: undefined,
    effectSummary: '只基于岗位事实回答问题，不打开浏览器或执行抓取。',
    aliases: ['JD 问答', 'RAG 问答', '岗位问答'],
  },
];

const MODE_BY_ID = new Map(MODE_DEFINITIONS.map((definition) => [definition.modeId, definition]));

export const assistantModeIds = MODE_DEFINITIONS.map((definition) => definition.modeId) as [AssistantModeId, ...AssistantModeId[]];

export function listAssistantModeDefinitions(): readonly AssistantModeDefinition[] {
  return MODE_DEFINITIONS;
}

export function getAssistantModeDefinition(modeId: AssistantModeId): AssistantModeDefinition {
  const definition = MODE_BY_ID.get(modeId);
  if (!definition) {
    throw new Error(`assistant-mode-unknown: ${modeId}`);
  }
  return definition;
}

export function isAssistantModeId(value: unknown): value is AssistantModeId {
  return typeof value === 'string' && MODE_BY_ID.has(value as AssistantModeId);
}

/**
 * Derives the legacy task kind and implied search source from a mode.  The
 * returned object is a fresh input copy so model/client objects are never
 * mutated in place.
 */
export function compileAssistantModeInput(
  modeId: AssistantModeId,
  input: Record<string, unknown>,
): { kind: AssistantModeTaskKind; input: Record<string, unknown>; definition: AssistantModeDefinition } {
  const definition = getAssistantModeDefinition(modeId);
  const compiled = { ...input };
  delete compiled.modeId;
  delete compiled.kind;
  delete compiled.modeLabel;
  delete compiled.effectSummary;

  if (definition.modeId === 'capture.subscription-search') {
    compiled.searchSource = 'saved';
  } else if (definition.modeId === 'capture.direct-search') {
    compiled.searchSource = 'direct';
  } else if (definition.modeId === 'capture.reuse-job-settings') {
    delete compiled.searchSource;
  } else if (definition.modeId === 'subscription.manage') {
    delete compiled.searchSource;
  }

  return {
    kind: definition.taskKind,
    input: compiled,
    definition,
  };
}

/**
 * Maps an older kind/input draft to a mode only when the meaning is unique.
 * An omitted source means “do not override the runtime's canonical source”.
 * Existing jobs therefore keep their saved/direct setting, while new jobs
 * retain the historical saved default in the normal capture parser.
 */
export function inferAssistantModeId(
  kind: AssistantModeTaskKind,
  input: Record<string, unknown>,
): AssistantModeId {
  if (kind === 'resume-capture') {
    if (input.searchSource === 'direct') return 'capture.direct-search';
    if (input.searchSource === 'saved') return 'capture.subscription-search';
    return 'capture.reuse-job-settings';
  }
  if (kind === 'batch') return 'batch.capture';
  if (kind === 'search-subscription') return 'subscription.manage';
  if (kind === 'talent-mapping') return 'talent-mapping.run';
  if (kind === 'boss-auto-chat') return 'boss.auto-chat';
  if (kind === 'boss-talent-search') return 'boss.talent-search';
  if (kind === 'boss-greet') return 'boss.greet';
  if (kind === 'boss-chat-operation') return 'boss.chat-operation';
  if (kind === 'boss-job-sync') return 'boss.job-sync';
  if (kind === 'login-refresh') return 'session.login-refresh';
  if (kind === 'rag-ops') return 'rag.ops';
  if (kind === 'rag-answer') return 'rag.answer';
  throw new Error(`assistant-mode-unknown: kind=${kind}`);
}

export function assertAssistantModeMatchesKind(
  modeId: AssistantModeId,
  kind: AssistantModeTaskKind,
): AssistantModeDefinition {
  const definition = getAssistantModeDefinition(modeId);
  if (definition.taskKind !== kind) {
    throw new Error(`assistant-mode-conflict: ${modeId} derives ${definition.taskKind}, received ${kind}`);
  }
  return definition;
}
