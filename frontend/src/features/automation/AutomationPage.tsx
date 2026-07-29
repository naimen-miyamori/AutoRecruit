import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Pause, Play, Plus, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import type { Platform, SchedulableTaskKind } from '../../api/contracts';
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
  kind: SchedulableTaskKind;
  platform: string;
  keyword: string;
  file: string;
}

const initialForm: ScheduleForm = { name: '', start: '09:00', end: '18:00', delaySeconds: '1800', failureDelaySeconds: '300', failurePolicy: 'stop-round', pauseAfterConsecutiveFailures: '3', kind: 'resume-capture', platform: '51job', keyword: '', file: '' };

export function AutomationPage() {
  const queryClient = useQueryClient();
  const schedulesQuery = useQuery({ queryKey: queryKeys.schedules, queryFn: ({ signal }) => api.listSchedules(signal), refetchInterval: (query) => query.state.data?.schedules.some((item) => item.status === 'enabled' || item.status === 'stop_requested') ? 5_000 : false });
  const [selectedId, setSelectedId] = useState<string>();
  const selected = selectedId ?? schedulesQuery.data?.schedules[0]?.scheduleId;
  const scheduleQuery = useQuery({ queryKey: queryKeys.schedule(selected ?? ''), queryFn: ({ signal }) => api.getSchedule(selected!, signal), enabled: Boolean(selected), refetchInterval: 5_000 });
  const runsQuery = useQuery({ queryKey: queryKeys.scheduleRuns(selected ?? ''), queryFn: ({ signal }) => api.listScheduleRuns(selected!, signal), enabled: Boolean(selected), refetchInterval: 5_000 });
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState<string>();
  const [loginPlatform, setLoginPlatform] = useState<Platform>('51job');
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
  const createMutation = useMutation({ mutationFn: (body: Record<string, unknown>) => api.createSchedule(body), onSuccess: (item) => { setSelectedId(item.scheduleId); setForm(initialForm); invalidate(); } });
  const controlMutation = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'start' | 'pause' | 'stop' | 'run-now' }) => api.controlSchedule(id, action), onSuccess: () => { invalidate(); void scheduleQuery.refetch(); void runsQuery.refetch(); } });
  const loginMutation = useMutation({ mutationFn: () => api.submitTask('login-refresh', { platform: loginPlatform }) });
  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const taskInput = (): Record<string, unknown> => {
    if (form.kind === 'resume-capture') return { platform: form.platform, keyword: form.keyword };
    if (form.kind === 'batch') return { platform: form.platform, jobsFile: form.file };
    if (form.kind === 'talent-mapping') return { platform: form.platform, talentMappingFile: form.file, mappingStage: 'scan' };
    if (form.kind === 'search-subscription') return { platform: form.platform, searchSubscriptionFile: form.file };
    if (form.kind === 'boss-auto-chat') return { platform: 'boss', scoreThreshold: 70, requireAllHardRequirements: true };
    return { platform: 'boss', includeClosed: true };
  };
  const create = () => {
    setFormError(undefined);
    if (!form.name.trim()) return setFormError('计划名称必填');
    if (form.kind === 'resume-capture' && !form.keyword.trim()) return setFormError('简历抓取计划需要关键词');
    if ((form.kind === 'batch' || form.kind === 'search-subscription' || form.kind === 'talent-mapping') && !form.file.trim()) return setFormError('该计划任务需要文件路径');
    createMutation.mutate({ name: form.name.trim(), enabled: false, timeZone: 'Asia/Shanghai', dailyWindow: { start: form.start, end: form.end }, repeat: { mode: 'after-completion', delaySeconds: Number(form.delaySeconds), failureDelaySeconds: Number(form.failureDelaySeconds) }, failurePolicy: form.failurePolicy, pauseAfterConsecutiveFailures: Number(form.pauseAfterConsecutiveFailures), tasks: [{ taskKey: crypto.randomUUID(), name: TASK_LABELS[form.kind], enabled: true, kind: form.kind, input: taskInput() }] });
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
        <Section title={scheduleQuery.data?.name ?? '计划详情'} actions={scheduleQuery.data && <div className="page-actions"><button className="secondary-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'run-now' })}><Play size={15} />立即运行</button>{scheduleQuery.data.status === 'enabled' ? <button className="secondary-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'pause' })}><Pause size={15} />暂停</button> : <button className="secondary-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'start' })}><Play size={15} />启用</button>}<button className="danger-button" type="button" onClick={() => controlMutation.mutate({ id: scheduleQuery.data!.scheduleId, action: 'stop' })}><Square size={15} />当前任务后停止</button></div>}>
          {!selected && <EmptyState title="选择一个计划" />}
          {scheduleQuery.isLoading && <LoadingState />}
          {scheduleQuery.data && <><div className="detail-grid"><div className="detail-cell"><span>状态</span><strong>{scheduleQuery.data.status}</strong></div><div className="detail-cell"><span>时区 / 窗口</span><strong>{scheduleQuery.data.timeZone} · {scheduleQuery.data.dailyWindow.start}-{scheduleQuery.data.dailyWindow.end}</strong></div><div className="detail-cell"><span>完成后延迟</span><strong>{scheduleQuery.data.repeat.delaySeconds}s</strong></div><div className="detail-cell"><span>连续失败</span><strong>{scheduleQuery.data.consecutiveFailures}</strong></div></div><div className="card-list">{scheduleQuery.data.tasks.map((task) => <div className="compact-item" key={task.taskKey}><Clock3 size={17} /><div><strong>{task.name}</strong><small>{TASK_LABELS[task.kind]} · {String(task.input.platform ?? '')}</small></div><StatusPill status={task.enabled ? 'ok' : 'neutral'} label={task.enabled ? '启用' : '停用'} /></div>)}</div><h3>轮次历史</h3><div className="table-wrap"><table><thead><tr><th>轮次</th><th>状态</th><th>开始</th><th>结束</th><th>任务</th><th>错误</th></tr></thead><tbody>{runsQuery.data?.runs.map((run) => <tr key={run.runId}><td>#{run.cycleNumber}</td><td><StatusPill status={run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : run.status === 'running' ? 'running' : 'neutral'} label={run.status} /></td><td>{formatDate(run.startedAt)}</td><td>{formatDate(run.finishedAt)}</td><td>{run.completedTaskIds.length}/{run.taskIds.length}</td><td>{run.error ?? '-'}</td></tr>)}</tbody></table></div></>}
          {controlMutation.error && <ErrorState error={controlMutation.error} />}
        </Section>
      </div>
      <Section title="创建计划" description="先创建为暂停状态，核对后再显式启用。Talent Mapping 调度只接受 card-only 计划和 scan 阶段。">
        <div className="form-grid"><label><span>计划名称</span><input value={form.name} onChange={(event) => set('name', event.target.value)} /></label><label><span>开始时间</span><input type="time" value={form.start} onChange={(event) => set('start', event.target.value)} /></label><label><span>结束时间</span><input type="time" value={form.end} onChange={(event) => set('end', event.target.value)} /></label><label><span>任务类型</span><select value={form.kind} onChange={(event) => { const kind = event.target.value as SchedulableTaskKind; set('kind', kind); if (kind.startsWith('boss-')) set('platform', 'boss'); if (kind === 'talent-mapping' && form.platform === 'boss') set('platform', '51job'); }}><option value="resume-capture">简历抓取</option><option value="batch">批量任务</option><option value="talent-mapping">人才地图 card-only 扫描</option><option value="search-subscription">搜索订阅</option><option value="boss-auto-chat">Boss 自动沟通</option><option value="boss-job-sync">Boss 职位同步</option></select></label><label><span>平台</span><select value={form.platform} disabled={form.kind.startsWith('boss-')} onChange={(event) => set('platform', event.target.value)}><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option><option value="boss" disabled={form.kind === 'talent-mapping'}>Boss</option><option value="all">全部主平台</option></select></label>{form.kind === 'resume-capture' && <label><span>关键词</span><input value={form.keyword} onChange={(event) => set('keyword', event.target.value)} /></label>}{(form.kind === 'batch' || form.kind === 'search-subscription' || form.kind === 'talent-mapping') && <label><span>{form.kind === 'batch' ? 'Jobs 文件' : form.kind === 'search-subscription' ? '订阅文件' : 'card-only Mapping 计划文件'}</span><input value={form.file} onChange={(event) => set('file', event.target.value)} /></label>}<label><span>完成后延迟（秒）</span><input type="number" min="0" value={form.delaySeconds} onChange={(event) => set('delaySeconds', event.target.value)} /></label><label><span>失败后延迟（秒）</span><input type="number" min="1" value={form.failureDelaySeconds} onChange={(event) => set('failureDelaySeconds', event.target.value)} /></label><label><span>失败策略</span><select value={form.failurePolicy} onChange={(event) => set('failurePolicy', event.target.value as ScheduleForm['failurePolicy'])}><option value="stop-round">停止本轮</option><option value="continue">继续后续任务</option></select></label></div>
        <div className="form-actions"><button className="primary-button" type="button" disabled={createMutation.isPending} onClick={create}><Plus size={16} />创建暂停计划</button></div>{formError && <ErrorState error={new Error(formError)} />}{createMutation.error && <ErrorState error={createMutation.error} />}
      </Section>
      <Section title="平台登录刷新" description="有头浏览器可等待手工登录；刷新任务同样进入共享队列。"><div className="toolbar"><label><span>平台</span><select value={loginPlatform} onChange={(event) => setLoginPlatform(event.target.value as Platform)}>{(['51job', 'liepin', 'zhilian', 'boss'] as Platform[]).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item]}</option>)}</select></label><button className="primary-button" type="button" disabled={loginMutation.isPending} onClick={() => loginMutation.mutate()}><RefreshCw size={16} />创建刷新任务</button></div>{loginMutation.data && <div className="success-banner">任务已创建：{loginMutation.data.taskId}</div>}{loginMutation.error && <ErrorState error={loginMutation.error} />}</Section>
    </div>
  );
}
