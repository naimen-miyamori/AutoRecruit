import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BriefcaseBusiness, CheckCircle2, Loader2, RefreshCw, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, queryKeys } from '../../api/client';
import { EmptyState, ErrorState, IconButton, Metric, PageHeader, PLATFORM_LABELS, Section, StatusPill, TASK_LABELS, formatCompactDate } from '../../components/ui';

export function DashboardPage() {
  const tasksQuery = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: ({ signal }) => api.listTasks(signal),
    refetchInterval: (query) => query.state.data?.tasks.some((task) => task.status === 'queued' || task.status === 'running') ? 3_000 : 30_000,
  });
  const healthQuery = useQuery({ queryKey: queryKeys.dashboard, queryFn: ({ signal }) => api.dashboardHealth(signal), refetchInterval: 30_000 });
  const jobsQuery = useQuery({ queryKey: queryKeys.jobs(), queryFn: ({ signal }) => api.listJobs(undefined, signal), refetchInterval: 30_000 });
  const refresh = () => void Promise.all([tasksQuery.refetch(), healthQuery.refetch(), jobsQuery.refetch()]);
  const tasks = tasksQuery.data?.tasks ?? [];
  const jobs = jobsQuery.data?.jobs ?? [];
  const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
  const failed = tasks.filter((task) => task.status === 'failed');
  const health = healthQuery.data;
  const totalCandidates = health?.candidateFunnels.reduce((sum, item) => sum + item.capturedResumes, 0) ?? 0;
  const totalScored = health?.candidateFunnels.reduce((sum, item) => sum + item.scoredCandidates, 0) ?? 0;
  const sessionProblems = health?.sessions.filter((item) => !item.exists || item.recentLoginRefreshStatus === 'failed') ?? [];
  const runProblems = health?.platformRuns.filter((item) => item.consecutiveFailures > 0) ?? [];
  const rejectionEmailHealth = health?.bossRejectionEmails;
  const unresolvedRejectionEmails = (rejectionEmailHealth?.pending ?? 0)
    + (rejectionEmailHealth?.sending ?? 0)
    + (rejectionEmailHealth?.retryableFailed ?? 0)
    + (rejectionEmailHealth?.retryExhausted ?? 0)
    + (rejectionEmailHealth?.uncertain ?? 0);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="OPERATIONS" title="招聘运营控制台" description="查看真实运行状态、优先处理异常，再进入岗位或 Boss 工作流。" actions={<><Link className="secondary-button" to="/assistant">智能助手</Link><Link className="primary-button" to="/run">新建任务</Link><IconButton label="刷新" onClick={refresh}><RefreshCw size={17} /></IconButton></>} />
      {(tasksQuery.error || healthQuery.error || jobsQuery.error) && <ErrorState error={tasksQuery.error ?? healthQuery.error ?? jobsQuery.error} onRetry={refresh} />}
      <div className="metric-grid">
        <Metric label="执行中" value={active.length} note={`${tasks.filter((item) => item.status === 'queued').length} 个排队`} tone={active.length ? 'info' : 'default'} icon={active.length ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />} />
        <Metric label="失败任务" value={failed.length} note="当前任务记录" tone={failed.length ? 'danger' : 'success'} icon={<AlertTriangle size={16} />} />
        <Metric label="岗位" value={jobs.length} note="四平台本地记录" icon={<BriefcaseBusiness size={16} />} />
        <Metric label="已抓取简历" value={totalCandidates} note="本地权威数据" icon={<UsersRound size={16} />} />
        <Metric label="已评分" value={totalScored} note="运行累计" tone="success" />
        <Metric label="会话异常" value={sessionProblems.length} note="登录态或刷新失败" tone={sessionProblems.length ? 'warning' : 'success'} />
        <Metric label="否定邮件待处理" value={unresolvedRejectionEmails} note={rejectionEmailHealth?.uncertain ? `${rejectionEmailHealth.uncertain} 封结果不确定` : rejectionEmailHealth?.retryExhausted ? `${rejectionEmailHealth.retryExhausted} 封自动重试已用尽` : rejectionEmailHealth?.sending ? `${rejectionEmailHealth.sending} 封发送中断待核对` : 'Boss 候选人级 outbox'} tone={rejectionEmailHealth?.uncertain || rejectionEmailHealth?.sending ? 'danger' : unresolvedRejectionEmails ? 'warning' : 'success'} />
      </div>
      <div className="two-column">
        <Section title="优先处理" description="失败、登录态和连续失败会集中在这里。">
          <div className="attention-list">
            {failed.slice(0, 4).map((task) => <div className="attention-item danger" key={task.taskId}><AlertTriangle size={17} /><div><strong>{TASK_LABELS[task.kind]}</strong><small>{task.error ?? '任务执行失败'}</small></div><Link className="text-link" to={`/tasks/${encodeURIComponent(task.taskId)}`}>查看</Link></div>)}
            {sessionProblems.map((item) => <div className="attention-item warning" key={item.platform}><AlertTriangle size={17} /><div><strong>{PLATFORM_LABELS[item.platform]} 会话</strong><small>{item.recentLoginRefreshError ?? '未找到可用登录态'}</small></div><Link className="text-link" to="/automation">刷新登录</Link></div>)}
            {runProblems.map((item) => <div className="attention-item warning" key={item.platform}><AlertTriangle size={17} /><div><strong>{PLATFORM_LABELS[item.platform]} 连续失败 {item.consecutiveFailures} 次</strong><small>{item.latestFailureMessage ?? '查看最近运行'}</small></div><Link className="text-link" to="/tasks">任务</Link></div>)}
            {rejectionEmailHealth && rejectionEmailHealth.uncertain > 0 && <div className="attention-item danger"><AlertTriangle size={17} /><div><strong>Boss 否定邮件有 {rejectionEmailHealth.uncertain} 封结果不确定</strong><small>不会自动重发，请人工核对 SMTP 收件箱和投递日志。</small></div><Link className="text-link" to="/tasks">任务</Link></div>}
            {rejectionEmailHealth && rejectionEmailHealth.sending > 0 && <div className="attention-item danger"><AlertTriangle size={17} /><div><strong>Boss 否定邮件有 {rejectionEmailHealth.sending} 封停留在 sending</strong><small>上次进程可能在 SMTP 调用期间中断；下次 Boss 运行会转为 uncertain，期间请勿人工重发。</small></div><Link className="text-link" to="/tasks">任务</Link></div>}
            {rejectionEmailHealth && rejectionEmailHealth.retryExhausted > 0 && <div className="attention-item warning"><AlertTriangle size={17} /><div><strong>Boss 否定邮件有 {rejectionEmailHealth.retryExhausted} 封自动重试已用尽</strong><small>不会继续自动发送，请检查 SMTP 配置后人工处理。</small></div><Link className="text-link" to="/tasks">任务</Link></div>}
            {rejectionEmailHealth && rejectionEmailHealth.uncertain === 0 && rejectionEmailHealth.sending === 0 && rejectionEmailHealth.retryExhausted === 0 && (rejectionEmailHealth.pending > 0 || rejectionEmailHealth.retryableFailed > 0) && <div className="attention-item warning"><AlertTriangle size={17} /><div><strong>Boss 否定邮件有 {rejectionEmailHealth.pending + rejectionEmailHealth.retryableFailed} 封待处理</strong><small>已关闭详情的 pending/retryable-failed 邮件会在下一轮恢复。</small></div><Link className="text-link" to="/tasks">任务</Link></div>}
            {failed.length === 0 && sessionProblems.length === 0 && runProblems.length === 0 && unresolvedRejectionEmails === 0 && <EmptyState title="暂无待处理异常" description="最近任务与平台会话状态正常。" />}
          </div>
        </Section>
        <Section title="运行轨道" description="运行中页面每 3 秒自动更新。" actions={<Link className="text-link" to="/tasks">全部任务</Link>}>
          <div className="compact-list">
            {tasks.slice(0, 7).map((task) => <Link className="compact-item" to={`/tasks/${encodeURIComponent(task.taskId)}`} key={task.taskId}><StatusPill status={task.status} /><div><strong>{TASK_LABELS[task.kind]}</strong><small>{String(task.inputSummary.platform ?? '')} · {String(task.inputSummary.keyword ?? task.inputSummary.jobKey ?? task.inputSummary.action ?? '')}</small></div><time>{formatCompactDate(task.updatedAt)}</time></Link>)}
            {tasks.length === 0 && <EmptyState title="还没有任务" description="从“新建任务”开始第一次运行。" />}
          </div>
        </Section>
      </div>
      {rejectionEmailHealth && <Section title="Boss 否定邮件交付" description="按本地 outbox 统计，不显示候选人正文或 SMTP 凭据。"><div className="detail-grid"><div className="detail-cell"><span>Outbox 总数</span><strong>{rejectionEmailHealth.outboxCount}</strong></div><div className="detail-cell"><span>已发送</span><strong>{rejectionEmailHealth.sent}</strong></div><div className="detail-cell"><span>待处理</span><strong>{rejectionEmailHealth.pending}</strong></div><div className="detail-cell"><span>发送中</span><strong>{rejectionEmailHealth.sending}</strong></div><div className="detail-cell"><span>可重试失败</span><strong>{rejectionEmailHealth.retryableFailed}</strong></div><div className="detail-cell"><span>自动重试已用尽</span><strong>{rejectionEmailHealth.retryExhausted}</strong></div><div className="detail-cell"><span>结果不确定</span><strong>{rejectionEmailHealth.uncertain}</strong></div><div className="detail-cell"><span>已废弃</span><strong>{rejectionEmailHealth.superseded}</strong></div></div></Section>}
      {health && <Section title="平台健康矩阵" description={`生成于 ${formatCompactDate(health.generatedAt)}`}><div className="table-wrap"><table><thead><tr><th>平台</th><th>岗位 / 运行</th><th>最近成功</th><th>连续失败</th><th>零候选率</th><th>会话</th><th>筛选目录</th></tr></thead><tbody>{health.platformRuns.map((item) => { const session = health.sessions.find((entry) => entry.platform === item.platform); const filter = health.filters.find((entry) => entry.platform === item.platform); return <tr key={item.platform}><td><span className={`platform-mark platform-${item.platform}`}>{PLATFORM_LABELS[item.platform]}</span></td><td>{item.jobCount} / {item.runCount}</td><td>{formatCompactDate(item.latestSuccessAt)}</td><td><StatusPill status={item.consecutiveFailures ? 'failed' : 'ok'} label={String(item.consecutiveFailures)} /></td><td>{Math.round(item.zeroCandidateRate * 100)}%</td><td><StatusPill status={session?.exists ? 'ok' : 'warning'} label={session?.exists ? '可用' : '缺失'} /></td><td><StatusPill status={filter?.exists && !filter.failedControls ? 'ok' : 'warning'} label={filter?.exists ? `${filter.fieldCount} 字段` : '缺失'} /></td></tr>; })}</tbody></table></div></Section>}
    </div>
  );
}
