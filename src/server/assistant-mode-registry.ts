/**
 * Stable user-facing operation modes for the console assistant.
 *
 * Task kinds and CLI flags remain compatibility/runtime concerns.  The
 * assistant emits a mode ID, and the server derives the task kind and any
 * implied search-source value from this registry.
 */

import {
  listOperationModeDefinitions,
  type OperationModeDefinition,
  type OperationModeId,
  type OperationModeSearchSource,
  type OperationModeTaskKind,
} from '../operation-modes.js';

export type AssistantModeId = OperationModeId;
export type AssistantModeTaskKind = OperationModeTaskKind;
export type AssistantModeSearchSource = OperationModeSearchSource;

export interface AssistantModeDefinition extends OperationModeDefinition {
  aliases: readonly string[];
}

const MODE_ALIASES: Partial<Record<OperationModeId, readonly string[]>> = {
  'capture.reuse-job-settings': ['复用岗位设置', '按岗位设置抓取'],
  'capture.subscription-search': ['订阅搜索', '保存的订阅搜索'],
  'capture.direct-search': ['直接搜索', '筛选搜索'],
  'batch.capture': ['批量抓取', '批量任务'],
  'subscription.manage': ['订阅管理', '订阅保存', '管理订阅'],
  'talent-mapping.run': ['人才地图', '人才研究'],
  'boss.auto-chat': ['Boss 自动沟通', 'Boss 自动聊天'],
  'boss.talent-search': ['Boss 人才发现', 'Boss 人才搜索', 'Boss 深度搜索'],
  'boss.greet': ['Boss 打招呼', 'Boss 招呼'],
  'boss.chat-operation': ['Boss 会话操作', 'Boss 聊天操作'],
  'boss.job-sync': ['Boss 职位同步', '同步 Boss 职位'],
  'session.login-refresh': ['登录态刷新', '刷新登录'],
  'rag.ops': ['RAG 运维', 'RAG 检查'],
  'rag.answer': ['JD 问答', 'RAG 问答', '岗位问答'],
};

const MODE_DEFINITIONS: readonly AssistantModeDefinition[] = listOperationModeDefinitions().map(
  (definition) => ({
    ...definition,
    aliases: MODE_ALIASES[definition.modeId] ?? [],
  }),
);

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
