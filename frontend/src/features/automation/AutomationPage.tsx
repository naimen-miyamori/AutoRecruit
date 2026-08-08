import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Pause, Play, Plus, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import {
  compileSearchOperationMode,
  isCliSearchModeId,
  recurringScheduleTaskKindIds,
} from '../../api/contracts';
import type {
  CliSearchModeId,
  Platform,
  SchedulableTaskKind,
  ScheduleValidationIssue,
} from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { EmptyState, ErrorState, IconButton, LoadingState, PageHeader, PLATFORM_LABELS, Section, StatusPill, TASK_LABELS, formatDate } from '../../components/ui';

interface ScheduleForm {
  name: string;
  start: string;
  end: string;
  delaySeconds: string;
  failureDelaySeconds: string;
  failurePolicy: 'stop-round' | 'continue';
  pauseAfterConsecutiveFailures: string;
  platform: string;
  includeBoss: boolean;
  keyword: string;
  batchSearchSource: '' | 'saved' | 'direct';
  file: string;
}

const initialForm: ScheduleForm = { name: '', start: '09:00', end: '18:00', delaySeconds: '1800', failureDelaySeconds: '300', failurePolicy: 'stop-round', pauseAfterConsecutiveFailures: '3', platform: '51job', includeBoss: false, keyword: '', batchSearchSource: '', file: '' };
type ScheduleCreationSelection =
  | { type: 'search'; modeId: CliSearchModeId }
  | { type: 'independent'; kind: IndependentSchedulableTaskKind };

const INDEPENDENT_SCHEDULE_KINDS = recurringScheduleTaskKindIds.filter(
  (kind): kind is Extract<SchedulableTaskKind, 'talent-mapping' | 'boss-job-sync'> => kind === 'talent-mapping' || kind === 'boss-job-sync',
);
type IndependentSchedulableTaskKind = (typeof INDEPENDENT_SCHEDULE_KINDS)[number];
const initialScheduleCreationSelection: ScheduleCreationSelection = { type: 'search', modeId: 'capture.reuse-job-settings' };

function scheduleTaskLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(TASK_LABELS, kind)
    ? TASK_LABELS[kind as keyof typeof TASK_LABELS]
    : `未知计划任务：${kind}`;
}

function scheduleValidationIssueDescription(issue: ScheduleValidationIssue): string {
  if (issue.code === 'scheduled-task-kind-not-allowed') {
    return `“${issue.kind}”不能作为循环计划运行。请完整移除该任务，改为手工或助手确认的一次性任务。`;
  }
  if (issue.code === 'scheduled-task-template-invalid') {
    return '历史计划任务结构不完整。请用完整、受支持的计划任务替换该模板。';
  }
  if (issue.code === 'schedule-record-invalid') {
    return '历史计划元数据结构不完整。请提交一份完整、合法的计划配置后再启用。';
  }
  return `“${issue.kind}”不是受支持的循环计划任务。请将其替换为受支持的计划任务。`;
}

export function AutomationPage() {
  const queryClient = useQueryClient();
  const schedulesQuery = useQuery({ queryKey: queryKeys.schedules, queryFn: ({ signal }) => api.listSchedules(signal), refetchInterval: (query) => query.state.data?.schedules.some((item) => item.status === 'enabled' || item.status === 'stop_requested') ? 5_000 : false });
  const operationModesQuery = useQuery({ queryKey: queryKeys.operationModes('schedule'), queryFn: ({ signal }) => api.listOperationModes('schedule', signal) });
  const [selection, setSelection] = useState<ScheduleCreationSelection>(initialScheduleCreationSelection);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = selectedId ?? schedulesQuery.data?.schedules[0]?.scheduleId;
  const scheduleQuery = useQuery({ queryKey: queryKeys.schedule(selected ?? ''), queryFn: ({ signal }) => api.getSchedule(selected!, signal), enabled: Boolean(selected), refetchInterval: 5_000 });
  const runsQuery = useQuery({ queryKey: queryKeys.scheduleRuns(selected ?? ''), queryFn: ({ signal }) => api.listScheduleRuns(selected!, signal), enabled: Boolean(selected), refetchInterval: 5_000 });
  const scheduleTasks = scheduleQuery.data?.tasks ?? [];
  const unsafeSubscriptionTasks = scheduleTasks.filter((task) => task.kind === 'search-subscription'
    && (task.input.saveSearchSubscription === true || task.input.searchSubscriptionName !== undefined)) ?? [];
  const validationIssues = scheduleQuery.data?.validationIssues ?? [];
  const scheduleControlsBlocked = validationIssues.length > 0;
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState<string>();
  const [loginPlatform, setLoginPlatform] = useState<Platform>('51job');
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
  const createMutation = useMutation({ mutationFn: (body: Record<string, unknown>) => api.createSchedule(body), onSuccess: (item) => { setSelectedId(item.scheduleId); setSelection(initialScheduleCreationSelection); setForm(initialForm); invalidate(); } });
  const controlMutation = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'start' | 'pause' | 'stop' | 'run-now' }) => api.controlSchedule(id, action), onSuccess: () => { invalidate(); void scheduleQuery.refetch(); void runsQuery.refetch(); } });
  const loginMutation = useMutation({ mutationFn: () => api.submitTask('login-refresh', { platform: loginPlatform }) });
  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const selectedModeId = selection.type === 'search' ? selection.modeId : undefined;
  const compiledSearchMode = selectedModeId ? compileSearchOperationMode(selectedModeId) : undefined;
  const activeKind: SchedulableTaskKind = selection.type === 'search'
    ? compiledSearchMode!.taskKind
    : selection.kind;
  const catalogModes = operationModesQuery.data?.modes ?? [];
  const catalogGroups = operationModesQuery.data?.groups ?? [];
  const savedSourceLabel = catalogModes.find((item) => item.modeId === 'capture.subscription-search')?.label ?? '模式目录未就绪';
  const directSourceLabel = catalogModes.find((item) => item.modeId === 'capture.direct-search')?.label ?? '模式目录未就绪';
  const scheduleModeCatalogError = operationModesQuery.error;
  const scheduleModeCatalogUnavailable = operationModesQuery.isLoading || Boolean(scheduleModeCatalogError);
  const selectedMode = selectedModeId ? catalogModes.find((item) => item.modeId === selectedModeId) : undefined;
  const scheduleSearchGroups = catalogGroups
    .filter((group) => group.orders['schedule-search-create'] !== undefined)
    .sort((left, right) => (left.orders['schedule-search-create'] ?? 0) - (right.orders['schedule-search-create'] ?? 0));
  const scheduleSearchModes = catalogModes.filter((item) => item.pickerTargets.includes('schedule-search-create') && isCliSearchModeId(item.modeId));
  const selectSearchMode = (modeId: CliSearchModeId) => setSelection({ type: 'search', modeId });
  const selectIndependentKind = (kind: IndependentSchedulableTaskKind) => setForm((current) => ({
    ...current,
    platform: kind.startsWith('boss-') ? 'boss' : kind === 'talent-mapping' && current.platform === 'boss' ? '51job' : current.platform,
  }));
  const activateIndependentKind = (kind: IndependentSchedulableTaskKind) => {
    setSelection({ type: 'independent', kind });
    selectIndependentKind(kind);
  };
  const taskInput = (): Record<string, unknown> => {
    if (selection.type === 'search' && compiledSearchMode?.taskKind === 'resume-capture') {
      return { platform: form.platform, includeBoss: form.platform === 'all' ? form.includeBoss : undefined, keyword: form.keyword, searchSource: compiledSearchMode.searchSource };
    }
    if (selection.type === 'search' && compiledSearchMode?.taskKind === 'batch') {
      return { platform: form.platform, includeBoss: form.platform === 'all' ? form.includeBoss : undefined, jobsFile: form.file, searchSource: form.batchSearchSource || undefined };
    }
    if (selection.type === 'search' && compiledSearchMode?.taskKind === 'search-subscription') {
      return { platform: form.platform, includeBoss: form.platform === 'all' ? form.includeBoss : undefined, searchSubscriptionFile: form.file, saveSearchSubscription: false };
    }
    if (selection.type === 'independent' && selection.kind === 'talent-mapping') return { platform: form.platform, talentMappingFile: form.file, mappingStage: 'scan' };
    return { platform: 'boss', includeClosed: true };
  };
  const create = () => {
    setFormError(undefined);
    if (selection.type === 'search' && scheduleModeCatalogUnavailable) {
      if (scheduleModeCatalogError) return setFormError(`搜索模式目录读取失败：${scheduleModeCatalogError instanceof Error ? scheduleModeCatalogError.message : String(scheduleModeCatalogError)}`);
      return setFormError('正在读取搜索模式目录，请稍候。');
    }
    if (!form.name.trim()) return setFormError('计划名称必填');
    if (activeKind === 'resume-capture' && !form.keyword.trim()) return setFormError('简历抓取计划需要关键词');
    if ((activeKind === 'batch' || activeKind === 'search-subscription' || activeKind === 'talent-mapping') && !form.file.trim()) return setFormError('该计划任务需要文件路径');
    createMutation.mutate({ name: form.name.trim(), enabled: false, timeZone: 'Asia/Shanghai', dailyWindow: { start: form.start, end: form.end }, repeat: { mode: 'after-completion', delaySeconds: Number(form.delaySeconds), failureDelaySeconds: Number(form.failureDelaySeconds) }, failurePolicy: form.failurePolicy, pauseAfterConsecutiveFailures: Number(form.pauseAfterConsecutiveFailures), tasks: [{ taskKey: crypto.randomUUID(), name: selectedMode?.label ?? TASK_LABELS[activeKind], enabled: true, kind: activeKind, input: taskInput() }] });
  };
  const refresh = () => void Promise.all([schedulesQuery.refetch(), scheduleQuery.refetch(), runsQuery.refetch()]);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="AUTOMATION" title="自动化" description="循环计划按完成后延迟运行，并与所有手工任务共享串行队列。" actions={<IconButton label="刷新" onClick={refresh}><RefreshCw size={17} /></IconButton>} />
      {schedulesQuery.error && <ErrorState error={schedulesQuery.error} onRetry={refresh} />}
      <div className="two-column">
        <Section title="计划列表" description="停止会等待当前单个任务结束。">
          {schedulesQuery.isLoading && <LoadingState />}
          <div className="compact-list">{schedulesQuery.data?.schedules.map((item) => <button type="button" className={`compact-item clickable-row${item.scheduleId === selected ? ' selected' : ''}`} key={item.scheduleId} onClick={() => setSelectedId(item.scheduleId)}><StatusPill status={item.status === 'enabled' ? 'ok' : item.status === 'stop_requested' ? 'warning' : 'neutral'} label={item.status} /><div><strong>{item.name}</strong><small>{item.dailyWindow.start}-{item.dailyWindow.end} · {item.taskCount} 个任务</small></div><time>{formatDate(item.nextRunAt)}</time></button>)}</div>
          {!schedulesQuery.isLoading && !schedulesQuery.data?.schedules.length && <EmptyState title="暂无循环计划" />}
        </Section>
        <Section title={scheduleQuery.data?.name ?? '计划详情'} actions={scheduleQuery.data && <div className="page-actions"><button className="secondary-button" type="button" disabled={scheduleControlsBlocked} onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'run-now' })}><Play size={15} />立即运行</button>{scheduleQuery.data.status === 'enabled' ? <button className="secondary-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'pause' })}><Pause size={15} />暂停</button> : <button className="secondary-button" type="button" disabled={scheduleControlsBlocked} onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'start' })}><Play size={15} />启用</button>}<button className="danger-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'stop' })}><Square size={15} />当前任务后停止</button></div>}>
          {!selected && <EmptyState title="选择一个计划" />}
          {scheduleQuery.isLoading && <LoadingState />}
          {scheduleQuery.data && <>{validationIssues.map((issue) => <div className="error-banner" key={`${issue.taskKey}:${issue.code}:${issue.kind}`}><strong>循环计划已阻断（{issue.code}）</strong> · 任务 {issue.taskKey}：{scheduleValidationIssueDescription(issue)}</div>)}{unsafeSubscriptionTasks.length > 0 && <div className="error-banner">该历史计划请求保存或改名平台订阅；当前调度合同会在恢复或运行前拒绝这些任务。请将订阅管理模板更新为只读。</div>}<div className="detail-grid"><div className="detail-cell"><span>状态</span><strong>{scheduleQuery.data.status}</strong></div><div className="detail-cell"><span>时区 / 窗口</span><strong>{scheduleQuery.data.timeZone} · {scheduleQuery.data.dailyWindow.start}-{scheduleQuery.data.dailyWindow.end}</strong></div><div className="detail-cell"><span>完成后延迟</span><strong>{scheduleQuery.data.repeat.delaySeconds}s</strong></div><div className="detail-cell"><span>连续失败</span><strong>{scheduleQuery.data.consecutiveFailures}</strong></div></div><div className="card-list">{scheduleTasks.map((task, index) => <div className="compact-item" key={`${task.taskKey}:${index}`}><Clock3 size={17} /><div><strong>{task.name}</strong><small>{scheduleTaskLabel(task.kind)} · {String(task.input.platform ?? '')}</small></div><StatusPill status={task.enabled ? 'ok' : 'neutral'} label={task.enabled ? '启用' : '停用'} /></div>)}</div><h3>轮次历史</h3><div className="table-wrap"><table><thead><tr><th>轮次</th><th>状态</th><th>开始</th><th>结束</th><th>任务</th><th>错误</th></tr></thead><tbody>{runsQuery.data?.runs.map((run) => <tr key={run.runId}><td>#{run.cycleNumber}</td><td><StatusPill status={run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : run.status === 'running' ? 'running' : 'neutral'} label={run.status} /></td><td>{formatDate(run.startedAt)}</td><td>{formatDate(run.finishedAt)}</td><td>{run.completedTaskIds.length}/{run.taskIds.length}</td><td>{run.error ?? '-'}</td></tr>)}</tbody></table></div></>}
          {controlMutation.error && <ErrorState error={controlMutation.error} />}
        </Section>
      </div>
      <Section title="搜索计划模式" description="以下搜索业务模式来自服务端目录；独立计划在下方单独选择。">
        {operationModesQuery.isLoading && <LoadingState label="读取搜索模式目录" />}
        {scheduleModeCatalogError && <ErrorState error={scheduleModeCatalogError} onRetry={() => void operationModesQuery.refetch()} />}
        {!operationModesQuery.isLoading && !scheduleModeCatalogError && <div className="mode-picker-list">{scheduleSearchGroups.map((group) => <div className="mode-picker-group" key={group.groupId}><h3>{group.label}</h3><div className="segmented">{scheduleSearchModes.filter((item) => item.pickerGroupId === group.groupId).sort((left, right) => (left.pickerOrder ?? 0) - (right.pickerOrder ?? 0)).map((item) => <button type="button" className={selectedModeId === item.modeId ? 'active' : ''} aria-label={item.label} aria-pressed={selectedModeId === item.modeId} key={item.modeId} onClick={() => { if (isCliSearchModeId(item.modeId)) selectSearchMode(item.modeId); }}><span>{item.label}</span><small>{item.declaredEffects}</small></button>)}</div></div>)}</div>}
      </Section>
      <Section title="独立计划类型" description="人才地图和 Boss 职位同步不依赖搜索模式目录。Boss 自动沟通仅可作为一次性或助手确认任务运行。">
        <label><span>任务类型</span><select aria-label="独立计划类型" value={selection.type === 'independent' ? selection.kind : ''} onChange={(event) => { if (event.target.value) activateIndependentKind(event.target.value as IndependentSchedulableTaskKind); }}><option value="">请选择独立任务</option>{INDEPENDENT_SCHEDULE_KINDS.map((kind) => <option value={kind} key={kind}>{TASK_LABELS[kind]}</option>)}</select></label>
      </Section>
      <Section title="创建计划" description={activeKind === 'search-subscription' ? '先创建为暂停状态；调度入口只读取平台原生订阅，不保存、不改名、不抓取候选或打开详情。全部平台默认不包含 Boss。' : '先创建为暂停状态，核对后再显式启用。Talent Mapping 调度只接受 card-only 计划和 scan 阶段。'}>
        <div className="form-grid"><label><span>计划名称</span><input value={form.name} onChange={(event) => set('name', event.target.value)} /></label><label><span>开始时间</span><input type="time" value={form.start} onChange={(event) => set('start', event.target.value)} /></label><label><span>结束时间</span><input type="time" value={form.end} onChange={(event) => set('end', event.target.value)} /></label><label><span>平台</span><select value={form.platform} disabled={activeKind.startsWith('boss-')} onChange={(event) => set('platform', event.target.value)}><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option><option value="boss" disabled={activeKind === 'talent-mapping'}>Boss</option><option value="all">全部主平台</option></select></label>{form.platform === 'all' && (activeKind === 'resume-capture' || activeKind === 'batch' || activeKind === 'search-subscription') && <label className="checkbox-field"><input type="checkbox" checked={form.includeBoss} onChange={(event) => set('includeBoss', event.target.checked)} />{activeKind === 'search-subscription' ? '当前模式包含 Boss 第 4 阶段' : '包含 Boss 直聘·直猎邦 Pro'}</label>}{form.platform === 'all' && activeKind === 'search-subscription' && form.includeBoss && <div className="security-note wide">Boss 仅读取“我的订阅”；不会保存、改名、抓取候选、打开详情、写 seen/评分/报告或发送邮件。</div>}{activeKind === 'resume-capture' && <><label><span>关键词</span><input value={form.keyword} onChange={(event) => set('keyword', event.target.value)} /></label><div className="security-note wide">{selectedMode ? `${selectedMode.label}：${selectedMode.declaredEffects}` : '请先在上方选择模式。'}</div></>}{(activeKind === 'batch' || activeKind === 'search-subscription' || activeKind === 'talent-mapping') && <label><span>{activeKind === 'batch' ? 'Jobs 文件' : activeKind === 'search-subscription' ? '订阅文件' : 'card-only Mapping 计划文件'}</span><input value={form.file} onChange={(event) => set('file', event.target.value)} /></label>}{activeKind === 'batch' && <><label><span>批量条目默认搜索来源</span><select value={form.batchSearchSource} onChange={(event) => set('batchSearchSource', event.target.value as ScheduleForm['batchSearchSource'])}><option value="">按每个岗位设置</option><option value="saved">{savedSourceLabel}</option><option value="direct">{directSourceLabel}</option></select></label><div className="security-note wide">{selectedMode ? `${selectedMode.label}：${selectedMode.declaredEffects}` : '请先在上方选择模式。'}</div></>}{activeKind === 'search-subscription' && <div className="security-note wide">{selectedMode ? `通用模式说明：${selectedMode.declaredEffects}` : '请先在上方选择模式。'} 调度约束：本计划只读取订阅条件和结果，不保存或改名平台订阅，也不抓取候选或评分。</div>}<label><span>完成后延迟（秒）</span><input type="number" min="0" value={form.delaySeconds} onChange={(event) => set('delaySeconds', event.target.value)} /></label><label><span>失败后延迟（秒）</span><input type="number" min="1" value={form.failureDelaySeconds} onChange={(event) => set('failureDelaySeconds', event.target.value)} /></label><label><span>失败策略</span><select value={form.failurePolicy} onChange={(event) => set('failurePolicy', event.target.value as ScheduleForm['failurePolicy'])}><option value="stop-round">停止本轮</option><option value="continue">继续后续任务</option></select></label></div>
        <div className="form-actions"><button className="primary-button" type="button" disabled={createMutation.isPending || (selection.type === 'search' && scheduleModeCatalogUnavailable)} onClick={create}><Plus size={16} />创建暂停计划</button></div>{formError && <ErrorState error={new Error(formError)} />}{createMutation.error && <ErrorState error={createMutation.error} />}
      </Section>
      <Section title="平台登录刷新" description="有头浏览器可等待手工登录；刷新任务同样进入共享队列。"><div className="toolbar"><label><span>平台</span><select value={loginPlatform} onChange={(event) => setLoginPlatform(event.target.value as Platform)}>{(['51job', 'liepin', 'zhilian', 'boss'] as Platform[]).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item]}</option>)}</select></label><button className="primary-button" type="button" disabled={loginMutation.isPending} onClick={() => loginMutation.mutate()}><RefreshCw size={16} />创建刷新任务</button></div>{loginMutation.data && <div className="success-banner">任务已创建：{loginMutation.data.taskId}</div>}{loginMutation.error && <ErrorState error={loginMutation.error} />}</Section>
    </div>
  );
}
