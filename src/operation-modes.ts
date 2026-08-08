export type OperationModeSurface = 'assistant' | 'manual' | 'schedule' | 'cli';
export type OperationModePickerTarget = 'manual-search-create' | 'schedule-search-create';

export type OperationModeId =
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

export type OperationModeTaskKind =
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

/**
 * The only task kinds that may be persisted as recurring scheduler templates.
 * This intentionally differs from an operation mode's `schedule` surface:
 * a surface may expose a one-off automation workspace entry without granting
 * an open-ended recurring execution authorization.
 */
export const recurringScheduleTaskKindIds = [
  'resume-capture',
  'batch',
  'talent-mapping',
  'search-subscription',
  'boss-job-sync',
] as const satisfies readonly OperationModeTaskKind[];

export type RecurringScheduleTaskKind = (typeof recurringScheduleTaskKindIds)[number];

export type OperationModeSearchSource = 'saved' | 'direct' | 'reuse-job-settings' | undefined;

export interface OperationModePickerGroup {
  groupId: string;
  label: string;
  orders: Readonly<Partial<Record<OperationModePickerTarget, number>>>;
}

export interface OperationModeDefinition {
  modeId: OperationModeId;
  label: string;
  taskKind: OperationModeTaskKind;
  searchSource: OperationModeSearchSource;
  effectSummary: string;
  surfaces: readonly OperationModeSurface[];
  pickerTargets: readonly OperationModePickerTarget[];
  pickerGroupId?: string;
  pickerOrder?: number;
}

export const OPERATION_MODE_PICKER_GROUPS: readonly OperationModePickerGroup[] = [
  {
    groupId: 'candidate-capture',
    label: '候选抓取',
    orders: { 'manual-search-create': 10, 'schedule-search-create': 10 },
  },
  {
    groupId: 'batch-capture',
    label: '批量任务',
    orders: { 'manual-search-create': 20, 'schedule-search-create': 20 },
  },
  {
    groupId: 'subscription-management',
    label: '平台订阅',
    orders: { 'manual-search-create': 30, 'schedule-search-create': 30 },
  },
];

export const OPERATION_MODE_DEFINITIONS: readonly OperationModeDefinition[] = [
  {
    modeId: 'capture.reuse-job-settings',
    label: '按岗位设置抓取',
    taskKind: 'resume-capture',
    searchSource: 'reuse-job-settings',
    effectSummary: '会做：按岗位设置执行普通抓取，可能打开候选详情、写入 seen、评分、导出或发送报告。不会做：不显式覆盖搜索来源。外部变化：可能复用岗位已保存的筛选、转发或邮件设置。',
    surfaces: ['assistant', 'manual', 'schedule', 'cli'],
    pickerTargets: ['manual-search-create', 'schedule-search-create'],
    pickerGroupId: 'candidate-capture',
    pickerOrder: 10,
  },
  {
    modeId: 'capture.subscription-search',
    label: '订阅搜索',
    taskKind: 'resume-capture',
    searchSource: 'saved',
    effectSummary: '会做：使用平台已保存的订阅入口执行普通抓取，可能打开候选详情、写入 seen、评分、导出或发送报告。不会做：不转为直接搜索或订阅管理。外部变化：可能复用岗位已保存的转发或邮件设置。',
    surfaces: ['assistant', 'manual', 'schedule', 'cli'],
    pickerTargets: ['manual-search-create', 'schedule-search-create'],
    pickerGroupId: 'candidate-capture',
    pickerOrder: 20,
  },
  {
    modeId: 'capture.direct-search',
    label: '直接搜索',
    taskKind: 'resume-capture',
    searchSource: 'direct',
    effectSummary: '会做：完整应用本次条件后执行普通抓取，可能打开候选详情、写入 seen、评分、导出或发送报告。不会做：条件未完整应用时不继续，也不复用保存订阅引用。外部变化：可能按岗位设置转发或发送邮件。',
    surfaces: ['assistant', 'manual', 'schedule', 'cli'],
    pickerTargets: ['manual-search-create', 'schedule-search-create'],
    pickerGroupId: 'candidate-capture',
    pickerOrder: 30,
  },
  {
    modeId: 'batch.capture',
    label: '批量抓取',
    taskKind: 'batch',
    searchSource: undefined,
    effectSummary: '会做：按 jobs 文件逐项执行普通抓取，可能打开候选详情、写入 seen、评分、导出或发送报告。不会做：不把批量默认来源当作单项来源授权。外部变化：每项可能复用其岗位转发或邮件设置。',
    surfaces: ['assistant', 'manual', 'schedule', 'cli'],
    pickerTargets: ['manual-search-create', 'schedule-search-create'],
    pickerGroupId: 'batch-capture',
    pickerOrder: 10,
  },
  {
    modeId: 'subscription.manage',
    label: '订阅管理',
    taskKind: 'search-subscription',
    searchSource: undefined,
    effectSummary: '会做：应用订阅条件并读取结果。不会做：不抓取候选、打开详情、写 seen、评分、导出或发送报告。外部变化：仅在显式开启保存时保存或改名平台订阅。',
    surfaces: ['assistant', 'manual', 'schedule', 'cli'],
    pickerTargets: ['manual-search-create', 'schedule-search-create'],
    pickerGroupId: 'subscription-management',
    pickerOrder: 10,
  },
  {
    modeId: 'talent-mapping.run',
    label: '人才地图',
    taskKind: 'talent-mapping',
    searchSource: undefined,
    effectSummary: '执行独立的人才市场研究流程，不进入普通抓取状态。',
    surfaces: ['assistant', 'manual', 'schedule'],
    pickerTargets: [],
  },
  {
    modeId: 'boss.auto-chat',
    label: 'Boss 自动沟通',
    taskKind: 'boss-auto-chat',
    searchSource: undefined,
    effectSummary: '审查 Boss 未读会话并按确认的沟通策略执行。',
    surfaces: ['assistant', 'manual'],
    pickerTargets: [],
  },
  {
    modeId: 'boss.talent-search',
    label: 'Boss 人才发现',
    taskKind: 'boss-talent-search',
    searchSource: undefined,
    effectSummary: '执行 Boss 独立人才发现；匹配动作仍需要单独确认。',
    surfaces: ['assistant'],
    pickerTargets: [],
  },
  {
    modeId: 'boss.greet',
    label: 'Boss 打招呼',
    taskKind: 'boss-greet',
    searchSource: undefined,
    effectSummary: '向精确核验的 Boss 候选人发送一次打招呼。',
    surfaces: ['assistant'],
    pickerTargets: [],
  },
  {
    modeId: 'boss.chat-operation',
    label: 'Boss 会话操作',
    taskKind: 'boss-chat-operation',
    searchSource: undefined,
    effectSummary: '读取或修改精确 Boss 会话；变更操作需要确认。',
    surfaces: ['assistant'],
    pickerTargets: [],
  },
  {
    modeId: 'boss.job-sync',
    label: 'Boss 职位同步',
    taskKind: 'boss-job-sync',
    searchSource: undefined,
    effectSummary: '读取 Boss 职位并同步已验证的 JD 与职位身份。',
    surfaces: ['assistant', 'schedule'],
    pickerTargets: [],
  },
  {
    modeId: 'session.login-refresh',
    label: '登录态刷新',
    taskKind: 'login-refresh',
    searchSource: undefined,
    effectSummary: '通过平台登录流程刷新指定平台的会话状态。',
    surfaces: ['assistant', 'manual', 'schedule'],
    pickerTargets: [],
  },
  {
    modeId: 'rag.ops',
    label: 'RAG 运维',
    taskKind: 'rag-ops',
    searchSource: undefined,
    effectSummary: '执行受控的 RAG 检查、审核、指标或索引操作。',
    surfaces: ['assistant'],
    pickerTargets: [],
  },
  {
    modeId: 'rag.answer',
    label: 'JD/RAG 问答',
    taskKind: 'rag-answer',
    searchSource: undefined,
    effectSummary: '只基于岗位事实回答问题，不打开浏览器或执行抓取。',
    surfaces: ['assistant', 'manual'],
    pickerTargets: [],
  },
];

const OPERATION_MODE_BY_ID = new Map(OPERATION_MODE_DEFINITIONS.map((definition) => [definition.modeId, definition]));

export const operationModeIds = OPERATION_MODE_DEFINITIONS.map((definition) => definition.modeId) as [OperationModeId, ...OperationModeId[]];
export const operationModeTaskKindIds = [...new Set(OPERATION_MODE_DEFINITIONS.map((definition) => definition.taskKind))] as [OperationModeTaskKind, ...OperationModeTaskKind[]];
export const operationModePickerTargetIds: readonly OperationModePickerTarget[] = ['manual-search-create', 'schedule-search-create'];

const OPERATION_MODE_PICKER_GROUP_BY_ID = new Map(OPERATION_MODE_PICKER_GROUPS.map((group) => [group.groupId, group]));

export function listOperationModePickerGroups(target: OperationModePickerTarget): readonly OperationModePickerGroup[] {
  return OPERATION_MODE_PICKER_GROUPS
    .filter((group) => group.orders[target] !== undefined)
    .slice()
    .sort((left, right) => (left.orders[target] ?? 0) - (right.orders[target] ?? 0));
}

export function listOperationModeDefinitionsForPicker(target: OperationModePickerTarget): readonly OperationModeDefinition[] {
  return OPERATION_MODE_DEFINITIONS
    .filter((definition) => definition.pickerTargets.includes(target))
    .slice()
    .sort((left, right) => {
      const leftGroupOrder = left.pickerGroupId ? OPERATION_MODE_PICKER_GROUP_BY_ID.get(left.pickerGroupId)?.orders[target] ?? 0 : 0;
      const rightGroupOrder = right.pickerGroupId ? OPERATION_MODE_PICKER_GROUP_BY_ID.get(right.pickerGroupId)?.orders[target] ?? 0 : 0;
      return leftGroupOrder - rightGroupOrder || (left.pickerOrder ?? 0) - (right.pickerOrder ?? 0);
    });
}

export function assertOperationModeCatalogIntegrity(): void {
  const modeIds = new Set<string>();
  const groupIds = new Set<string>();
  const pickerKeys = new Set<string>();
  for (const group of OPERATION_MODE_PICKER_GROUPS) {
    if (groupIds.has(group.groupId)) throw new Error(`operation-mode-group-duplicate: ${group.groupId}`);
    groupIds.add(group.groupId);
    for (const target of operationModePickerTargetIds) {
      const order = group.orders[target];
      if (order === undefined) continue;
      const key = `${target}:${order}`;
      if (pickerKeys.has(key)) throw new Error(`operation-mode-group-order-duplicate: ${key}`);
      pickerKeys.add(key);
    }
  }
  const modePickerKeys = new Set<string>();
  for (const definition of OPERATION_MODE_DEFINITIONS) {
    if (modeIds.has(definition.modeId)) throw new Error(`operation-mode-duplicate: ${definition.modeId}`);
    modeIds.add(definition.modeId);
    if (definition.pickerTargets.length === 0) {
      if (definition.pickerGroupId !== undefined || definition.pickerOrder !== undefined) {
        throw new Error(`operation-mode-picker-fields-without-target: ${definition.modeId}`);
      }
      continue;
    }
    if (!definition.pickerGroupId || definition.pickerOrder === undefined) {
      throw new Error(`operation-mode-picker-fields-missing: ${definition.modeId}`);
    }
    if (!OPERATION_MODE_PICKER_GROUP_BY_ID.has(definition.pickerGroupId)) {
      throw new Error(`operation-mode-group-unknown: ${definition.pickerGroupId}`);
    }
    for (const target of definition.pickerTargets) {
      if (OPERATION_MODE_PICKER_GROUP_BY_ID.get(definition.pickerGroupId)?.orders[target] === undefined) {
        throw new Error(`operation-mode-group-target-unknown: ${definition.modeId}:${target}`);
      }
      const key = `${target}:${definition.pickerGroupId}:${definition.pickerOrder}`;
      if (modePickerKeys.has(key)) throw new Error(`operation-mode-picker-order-duplicate: ${key}`);
      modePickerKeys.add(key);
    }
  }
  const scheduledModeKinds = new Set(
    OPERATION_MODE_DEFINITIONS
      .filter((definition) => definition.surfaces.includes('schedule'))
      .map((definition) => definition.taskKind),
  );
  for (const taskKind of recurringScheduleTaskKindIds) {
    if (!scheduledModeKinds.has(taskKind)) {
      throw new Error(`operation-mode-recurring-kind-without-schedule-surface: ${taskKind}`);
    }
  }
}

assertOperationModeCatalogIntegrity();

export type CliSearchModeId =
  | 'capture.reuse-job-settings'
  | 'capture.subscription-search'
  | 'capture.direct-search'
  | 'batch.capture'
  | 'subscription.manage';

export const cliSearchModeIds: readonly CliSearchModeId[] = [
  'capture.reuse-job-settings',
  'capture.subscription-search',
  'capture.direct-search',
  'batch.capture',
  'subscription.manage',
];

export interface CompiledSearchOperationMode {
  taskKind: 'resume-capture' | 'batch' | 'search-subscription';
  searchSource?: 'saved' | 'direct';
}

export function compileSearchOperationMode(modeId: CliSearchModeId): CompiledSearchOperationMode {
  switch (modeId) {
    case 'capture.reuse-job-settings':
      return { taskKind: 'resume-capture' };
    case 'capture.subscription-search':
      return { taskKind: 'resume-capture', searchSource: 'saved' };
    case 'capture.direct-search':
      return { taskKind: 'resume-capture', searchSource: 'direct' };
    case 'batch.capture':
      return { taskKind: 'batch' };
    case 'subscription.manage':
      return { taskKind: 'search-subscription' };
    default:
      throw new Error(`operation-mode-unknown: ${String(modeId)}`);
  }
}

export function listOperationModeDefinitions(surface?: OperationModeSurface): readonly OperationModeDefinition[] {
  if (!surface) return OPERATION_MODE_DEFINITIONS;
  return OPERATION_MODE_DEFINITIONS.filter((definition) => definition.surfaces.includes(surface));
}

export function getOperationModeDefinition(modeId: OperationModeId): OperationModeDefinition {
  const definition = OPERATION_MODE_BY_ID.get(modeId);
  if (!definition) throw new Error(`operation-mode-unknown: ${modeId}`);
  return definition;
}

export function isOperationModeId(value: unknown): value is OperationModeId {
  return typeof value === 'string' && OPERATION_MODE_BY_ID.has(value as OperationModeId);
}

export function isOperationModeTaskKind(value: unknown): value is OperationModeTaskKind {
  return typeof value === 'string' && operationModeTaskKindIds.includes(value as OperationModeTaskKind);
}

export function isRecurringScheduleTaskKind(value: unknown): value is RecurringScheduleTaskKind {
  return typeof value === 'string' && recurringScheduleTaskKindIds.includes(value as RecurringScheduleTaskKind);
}

export function isCliSearchModeId(value: unknown): value is CliSearchModeId {
  return typeof value === 'string' && cliSearchModeIds.includes(value as CliSearchModeId);
}

export function deriveCliSearchModeId(input: {
  mode: 'single' | 'batch' | 'search-subscription';
  searchSource?: 'saved' | 'direct';
  searchSourceExplicit?: boolean;
}): CliSearchModeId {
  if (input.mode === 'batch') return 'batch.capture';
  if (input.mode === 'search-subscription') return 'subscription.manage';
  if (!input.searchSourceExplicit) return 'capture.reuse-job-settings';
  if (input.searchSource === 'saved') return 'capture.subscription-search';
  if (input.searchSource === 'direct') return 'capture.direct-search';
  throw new Error('operation-mode-conflict: single capture search source is invalid');
}

export function resolveOperationModeEffects(
  modeId: OperationModeId,
  context: {
    searchSource?: 'saved' | 'direct';
    searchSourceExplicit?: boolean;
    saveSearchSubscription?: boolean;
  } = {},
): string {
  switch (modeId) {
    case 'capture.reuse-job-settings':
      return '本次不覆盖搜索来源：已有岗位优先复用保存设置，新岗位沿用普通抓取默认来源。';
    case 'capture.subscription-search':
      return '本次使用已保存订阅入口抓取候选人；岗位后续评分、转发或邮件设置仍按岗位配置执行。';
    case 'capture.direct-search':
      return '本次使用直接搜索条件抓取候选人，不携带保存的订阅引用。';
    case 'batch.capture':
      return context.searchSourceExplicit
        ? `批量任务固定默认来源为${context.searchSource === 'direct' ? '直接搜索' : '订阅搜索'}；jobs 文件中的单项配置仍可覆盖它。`
        : '批量任务不固定全局来源；每个 jobs 文件项按自身配置执行，省略时复用岗位设置。';
    case 'subscription.manage':
      return context.saveSearchSubscription
        ? '本次只读取订阅条件并保存或更新平台订阅；不会抓取候选、评分或改变已读状态。'
        : '本次只读取订阅条件；不会保存订阅、抓取候选、评分或改变已读状态。';
    default:
      return getOperationModeDefinition(modeId).effectSummary;
  }
}
