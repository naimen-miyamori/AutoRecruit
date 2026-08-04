import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TaskKind, TaskStatus } from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { TaskOutput } from '../../components/TaskOutput';
import { EmptyState, ErrorState, IconButton, LoadingState, PageHeader, Section, StatusPill, TASK_LABELS, formatDate, formatCompactDate } from '../../components/ui';

export function TasksPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | TaskStatus>('all');
  const [kind, setKind] = useState<'all' | TaskKind>('all');
  const tasksQuery = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: ({ signal }) => api.listTasks(signal),
    refetchInterval: (query) => query.state.data?.tasks.some((item) => item.status === 'queued' || item.status === 'running') ? 3_000 : false,
  });
  const taskId = params.taskId ?? tasksQuery.data?.tasks[0]?.taskId;
  const detailQuery = useQuery({
    queryKey: queryKeys.task(taskId ?? ''),
    queryFn: ({ signal }) => api.getTask(taskId!, signal),
    enabled: Boolean(taskId),
    refetchInterval: (query) => query.state.data?.status === 'queued' || query.state.data?.status === 'running' ? 3_000 : false,
  });
  const tasks = useMemo(() => (tasksQuery.data?.tasks ?? []).filter((item) => (status === 'all' || item.status === status) && (kind === 'all' || item.kind === kind)), [tasksQuery.data, status, kind]);
  const detail = detailQuery.data;
  const refresh = () => void Promise.all([tasksQuery.refetch(), detailQuery.refetch()]);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="TASK QUEUE" title="任务中心" description="所有手工、助手和调度任务共享同一个串行队列。" actions={<IconButton label="刷新" onClick={refresh}><RefreshCw size={17} /></IconButton>} />
      {(tasksQuery.error || detailQuery.error) && <ErrorState error={tasksQuery.error ?? detailQuery.error} onRetry={refresh} />}
      <div className="split-layout">
        <Section className="sticky-panel" title="任务列表" description={`${tasks.length} 条结果`} actions={<div className="filter-row"><select aria-label="任务状态" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="queued">排队中</option><option value="running">运行中</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option></select><select aria-label="任务类型" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option>{Object.entries(TASK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}>
          {tasksQuery.isLoading && <LoadingState />}
          <div className="task-list">{tasks.map((task) => <button className={`task-item${task.taskId === taskId ? ' active' : ''}`} type="button" key={task.taskId} onClick={() => navigate(`/tasks/${encodeURIComponent(task.taskId)}`)}><StatusPill status={task.status} /><div className="task-item-content"><strong>{TASK_LABELS[task.kind]}</strong><span><b>{String(task.inputSummary.platform ?? '')}</b><time>{formatCompactDate(task.updatedAt)}</time></span>{task.error && <small className="inline-error">{task.error}</small>}</div></button>)}</div>
          {!tasksQuery.isLoading && tasks.length === 0 && <EmptyState title="没有符合条件的任务" />}
        </Section>
        <div className="page-stack">
          {!taskId && <Section><EmptyState title="选择一个任务" /></Section>}
          {detailQuery.isLoading && <Section><LoadingState label="读取任务详情" /></Section>}
          {detail && <>
            <Section title={TASK_LABELS[detail.kind]} description={detail.taskId} actions={<StatusPill status={detail.status} />}>
              <div className="detail-grid"><div className="detail-cell"><span>创建</span><strong>{formatDate(detail.createdAt)}</strong></div><div className="detail-cell"><span>开始</span><strong>{formatDate(detail.startedAt)}</strong></div><div className="detail-cell"><span>结束</span><strong>{formatDate(detail.finishedAt)}</strong></div><div className="detail-cell"><span>来源</span><strong>{detail.schedule ? `计划 ${detail.schedule.scheduleId}` : '手工 / 助手'}</strong></div></div>
              {detail.error && <div className="error-banner"><span>{detail.error}</span></div>}
            </Section>
            <Section title="任务结果" description="按任务类型展示完整输出，不仅显示摘要。"><TaskOutput kind={detail.kind} input={detail.input} output={detail.output} /></Section>
            <Section title="运行日志" description={`${detail.logs.length} 条`}><div className="timeline">{detail.logs.map((log, index) => <div className="timeline-item" key={`${log.at}-${index}`}><time>{formatCompactDate(log.at)}</time><StatusPill status={log.level === 'error' ? 'failed' : log.level === 'warn' ? 'warning' : 'neutral'} label={log.level} /><p>{log.message}</p></div>)}{detail.logs.length === 0 && <EmptyState title="暂无日志" />}</div></Section>
          </>}
        </div>
      </div>
    </div>
  );
}
