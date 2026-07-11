import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardList,
  Database,
  ExternalLink,
  FileQuestion,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MessageSquareText,
  MessageCircleQuestion,
  Play,
  RefreshCw,
  Search,
  Save,
  Settings2,
  Sparkles,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { api } from './api';
import type { ApplicationFilterField, ApplicationFilterOptions, AssistantActionKind, AssistantConfirmResponse, AssistantDraft, AssistantMessage, CandidateDetail, CandidateSummary, FilterCatalog, JobDetail, JobSummary, ModelConfig, Platform, RagAnswer, SavedFilterInput, TaskDetail, TaskKind, TaskStatus, TaskSummary } from './types';

type PageKey = 'dashboard' | 'tasks' | 'jobs' | 'assistant' | 'run' | 'rag' | 'ops' | 'settings' | 'guide' | 'job-detail' | 'candidate-detail';

interface RouteState {
  page: PageKey;
  platform?: Platform;
  jobKey?: string;
  candidateId?: string;
}

interface AsyncState<T> {
  data?: T;
  loading: boolean;
  error?: string;
  mocked?: boolean;
}

const NAV_ITEMS: Array<{ page: PageKey; label: string; icon: ReactNode; hash: string }> = [
  { page: 'dashboard', label: '总览', icon: <LayoutDashboard size={18} />, hash: '#/' },
  { page: 'tasks', label: '任务', icon: <ListChecks size={18} />, hash: '#/tasks' },
  { page: 'jobs', label: '岗位', icon: <BriefcaseBusiness size={18} />, hash: '#/jobs' },
  { page: 'assistant', label: '智能助手', icon: <Sparkles size={18} />, hash: '#/assistant' },
  { page: 'run', label: '执行搜索', icon: <Play size={18} />, hash: '#/run' },
  { page: 'rag', label: '问答', icon: <MessageCircleQuestion size={18} />, hash: '#/rag' },
  { page: 'ops', label: '运营', icon: <Settings2 size={18} />, hash: '#/ops' },
  { page: 'settings', label: '配置', icon: <Settings2 size={18} />, hash: '#/settings' },
  { page: 'guide', label: '说明', icon: <ClipboardList size={18} />, hash: '#/guide' },
];

const PLATFORM_LABELS: Record<Platform | 'all', string> = {
  all: '全部平台',
  '51job': '51job',
  liepin: '猎聘',
  zhilian: '智联',
  boss: 'Boss直聘',
};

const SINGLE_PLATFORM_OPTIONS: Platform[] = ['51job', 'liepin', 'zhilian', 'boss'];
const RUN_PLATFORM_OPTIONS: Array<Platform | 'all'> = [...SINGLE_PLATFORM_OPTIONS, 'all'];
const FILTER_PLATFORM_OPTIONS: Array<Platform | 'all'> = ['all', ...SINGLE_PLATFORM_OPTIONS];
const ALL_PLATFORM_NOTE = '全部平台仅包含 51job、猎聘、智联，不包含 Boss。';

function platformSelectOptions(values: Array<Platform | 'all'>): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: PLATFORM_LABELS[value] }));
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_KIND_LABELS: Record<TaskKind, string> = {
  'resume-capture': '简历抓取',
  batch: '批量任务',
  'search-subscription': '搜索订阅',
  'login-refresh': '登录刷新',
  'rag-ops': '问答运维',
};

const SEARCH_SOURCE_LABELS: Record<string, string> = {
  saved: '已保存搜索',
  direct: '直接搜索',
};

const LOG_LEVEL_LABELS: Record<string, string> = {
  info: '信息',
  warn: '警告',
  error: '错误',
};

const RAG_OPS_ACTION_LABELS: Record<string, string> = {
  doctor: '索引检查',
  review: '人工复核',
  metrics: '指标汇总',
  ops: '运维策略',
  rebuild: '重建索引',
};

function parseRoute(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) {
    return { page: 'dashboard' };
  }

  if (parts[0] === 'jobs' && parts[1] && parts[2] && parts[3] === 'candidates' && parts[4]) {
    return {
      page: 'candidate-detail',
      platform: parts[1] as Platform,
      jobKey: parts[2],
      candidateId: parts[4],
    };
  }

  if (parts[0] === 'jobs' && parts[1] && parts[2]) {
    return {
      page: 'job-detail',
      platform: parts[1] as Platform,
      jobKey: parts[2],
    };
  }

  if (['tasks', 'jobs', 'assistant', 'run', 'rag', 'ops', 'settings', 'guide'].includes(parts[0])) {
    return { page: parts[0] as PageKey };
  }

  return { page: 'dashboard' };
}

function useRoute(): [RouteState, (hash: string) => void] {
  const [route, setRoute] = useState<RouteState>(() => parseRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return [route, (hash: string) => {
    window.location.hash = hash;
    setRoute(parseRoute());
  }];
}

function formatDate(value?: string): string {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function formatPercent(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '-';
  }

  return `${Math.round(value * 100)}%`;
}

function formatHours(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return '-';
  }

  if (value < 1) {
    return '<1h';
  }

  return `${Math.round(value)}h`;
}

function formatShortText(value?: string, maxLength = 120): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatFailureLine(failedAt?: string, message?: string): string {
  if (!failedAt) {
    return '-';
  }

  const summary = formatShortText(message);
  return summary ? `${formatDate(failedAt)} ${summary}` : formatDate(failedAt);
}

function formatFailureTitle(failedAt?: string, message?: string): string | undefined {
  if (!failedAt) {
    return undefined;
  }

  const detail = message?.replace(/\s+/g, ' ').trim();
  return detail ? `${formatDate(failedAt)} ${detail}` : formatDate(failedAt);
}

function jobHash(job: Pick<JobSummary, 'platform' | 'jobKey'>): string {
  return `#/jobs/${encodeURIComponent(job.platform)}/${encodeURIComponent(job.jobKey)}`;
}

function candidateHash(candidate: Pick<CandidateSummary, 'platform' | 'jobKey' | 'candidateId'>): string {
  return `#/jobs/${encodeURIComponent(candidate.platform)}/${encodeURIComponent(candidate.jobKey)}/candidates/${encodeURIComponent(candidate.candidateId)}`;
}

function StatusChip({ status, label }: { status: TaskStatus | 'success' | 'failed' | undefined; label?: string }) {
  const defaultLabel = status && status in STATUS_LABELS
    ? STATUS_LABELS[status as TaskStatus]
    : status === 'success'
      ? '正常'
      : status === 'failed'
        ? '异常'
        : '未设置';
  return <span className={`status-chip status-${status ?? 'neutral'}`}>{label ?? defaultLabel}</span>;
}

function HealthStatusChip({ failed }: { failed: boolean }) {
  return <StatusChip status={failed ? 'failed' : 'success'} label={failed ? '异常' : '正常'} />;
}

function ScoreStatusChip({ status }: { status: 'success' | 'failed' | undefined }) {
  const label = status === 'success' ? '评分成功' : status === 'failed' ? '评分失败' : '未评分';
  return <span className={`status-chip status-${status ?? 'neutral'}`}>{label}</span>;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="icon-button" type="button" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="empty-state">
      <Loader2 className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

function ErrorBlock({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <div className="notice danger">
      <AlertTriangle size={18} />
      <span>{message}</span>
    </div>
  );
}

function MockNotice({ mocked }: { mocked?: boolean }) {
  if (!mocked) {
    return null;
  }

  return (
    <div className="notice">
      <Database size={18} />
      <span>API 未连接，当前显示本地 mock 数据。</span>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function App() {
  const [route, navigate] = useRoute();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AR</div>
          <div>
            <strong>Autorecruit</strong>
            <span>招聘运营控制台</span>
          </div>
        </div>
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.hash}
              className={route.page === item.page ? 'nav-item active' : 'nav-item'}
              type="button"
              onClick={() => navigate(item.hash)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="main-view">
        <TopBar route={route} />
        {route.page === 'dashboard' && <DashboardView />}
        {route.page === 'tasks' && <TasksView />}
        {route.page === 'jobs' && <JobsView navigate={navigate} />}
        {route.page === 'job-detail' && route.platform && route.jobKey && (
          <JobDetailView platform={route.platform} jobKey={route.jobKey} navigate={navigate} />
        )}
        {route.page === 'candidate-detail' && route.platform && route.jobKey && route.candidateId && (
          <CandidateDetailView platform={route.platform} jobKey={route.jobKey} candidateId={route.candidateId} />
        )}
        {route.page === 'assistant' && <AssistantView navigate={navigate} />}
        {route.page === 'run' && <RunJobView />}
        {route.page === 'rag' && <RagView />}
        {route.page === 'ops' && <OpsView />}
        {route.page === 'settings' && <SettingsView />}
        {route.page === 'guide' && <GuideView />}
      </main>
    </div>
  );
}

function TopBar({ route }: { route: RouteState }) {
  const title = route.page === 'candidate-detail'
    ? '候选人详情'
    : route.page === 'job-detail'
      ? '岗位详情'
      : NAV_ITEMS.find((item) => item.page === route.page)?.label ?? '总览';

  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        <p>{route.platform ? `${PLATFORM_LABELS[route.platform]} / ${route.jobKey ?? ''}` : '内部招聘运营控制台'}</p>
      </div>
      <div className="clock">{formatDate(new Date().toISOString())}</div>
    </header>
  );
}

function DashboardView() {
  const [state, setState] = useState<AsyncState<Awaited<ReturnType<typeof api.dashboard>>>>({ loading: true });

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      setState({ data: await api.dashboard(), loading: false });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const metrics = useMemo(() => {
    const tasks = state.data?.tasks ?? [];
    const jobs = state.data?.jobs ?? [];
    const health = state.data?.health;
    const anomalyCount = health?.dataAnomalies.reduce((sum, item) => sum + item.missingJd + item.emptyDirectories + item.exportOnlyDirectories, 0) ?? 0;
    const failedCandidates = health?.candidateFunnels.reduce((sum, item) => sum + item.failedCandidates, 0) ?? 0;
    return {
      running: tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
      succeeded: tasks.filter((task) => task.status === 'succeeded').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      zero: jobs.filter((job) => job.latestRun?.totalCandidates === 0).length,
      anomalyCount,
      failedCandidates,
    };
  }, [state.data]);

  const platformRows = useMemo(() => {
    const jobs = state.data?.jobs ?? [];
    const catalogs = state.data?.catalogs ?? [];
    const health = state.data?.health;
    return SINGLE_PLATFORM_OPTIONS.map((platform) => ({
      platform,
      jobs: jobs.filter((job) => job.platform === platform),
      catalog: catalogs.find((catalog) => catalog.platform === platform),
      run: health?.platformRuns.find((item) => item.platform === platform),
      anomaly: health?.dataAnomalies.find((item) => item.platform === platform),
    }));
  }, [state.data]);

  const health = state.data?.health;

  if (state.loading && !state.data) {
    return <LoadingBlock />;
  }

  return (
    <div className="view-stack">
      <SectionHeader title="运行概览" action={<IconButton title="刷新" onClick={load}><RefreshCw size={18} /></IconButton>} />
      <ErrorBlock message={state.error} />
      <MockNotice mocked={state.data?.mocked} />
      <div className="metric-grid">
        <MetricTile label="排队/运行" value={metrics.running} tone="active" icon={<Loader2 size={20} />} />
        <MetricTile label="成功任务" value={metrics.succeeded} tone="success" icon={<CheckCircle2 size={20} />} />
        <MetricTile label="失败任务" value={metrics.failed} tone="danger" icon={<XCircle size={20} />} />
        <MetricTile label="零候选 run" value={metrics.zero} tone="neutral" icon={<BarChart3 size={20} />} />
        <MetricTile label="数据异常" value={metrics.anomalyCount} tone={metrics.anomalyCount > 0 ? 'danger' : 'success'} icon={<AlertTriangle size={20} />} />
        <MetricTile label="处理失败" value={metrics.failedCandidates} tone={metrics.failedCandidates > 0 ? 'danger' : 'success'} icon={<FileQuestion size={20} />} />
      </div>
      <div className="panel">
        <SectionHeader title="平台状态" />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>岗位数</th>
                <th>候选人</th>
                <th>最近运行</th>
                <th>最近失败</th>
                <th>连续失败</th>
                <th>零结果率</th>
                <th>筛选目录</th>
              </tr>
            </thead>
            <tbody>
              {platformRows.map((row) => {
                const latestFailureLine = formatFailureLine(row.run?.latestFailureAt, row.run?.latestFailureMessage);
                const latestFailureTitle = formatFailureTitle(
                  row.run?.latestFailureAt,
                  row.run?.latestFailureDetail ?? row.run?.latestFailureMessage,
                );

                return (
                  <tr key={row.platform}>
                    <td><strong>{PLATFORM_LABELS[row.platform]}</strong></td>
                    <td>{row.jobs.length}</td>
                    <td>{row.jobs.reduce((sum, job) => sum + job.candidateCount, 0)}</td>
                    <td>{formatDate(row.run?.latestSuccessAt ?? row.jobs[0]?.latestRunAt)}</td>
                    <td className="failure-summary-cell" title={latestFailureTitle}>
                      <span className="failure-summary-text">{latestFailureLine}</span>
                    </td>
                    <td><HealthStatusChip failed={(row.run?.consecutiveFailures ?? 0) > 0} /> {row.run?.consecutiveFailures ?? 0}</td>
                    <td>{formatPercent(row.run?.zeroCandidateRate)}</td>
                    <td>{row.catalog ? `${row.catalog.stats.discoveredControls} 字段` : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {health && <DashboardHealthPanels health={health} />}
      <RecentTasksTable tasks={state.data?.tasks ?? []} />
    </div>
  );
}

function DashboardHealthPanels({ health }: { health: Awaited<ReturnType<typeof api.dashboard>>['health'] }) {
  return (
    <div className="health-grid">
      <section className="panel">
        <SectionHeader title="数据异常" />
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>目录</th>
                <th>有效</th>
                <th>缺 JD</th>
                <th>空目录</th>
                <th>仅导出</th>
                <th>样例</th>
              </tr>
            </thead>
            <tbody>
              {health.dataAnomalies.map((item) => (
                <tr key={item.platform}>
                  <td><strong>{PLATFORM_LABELS[item.platform]}</strong></td>
                  <td>{item.jobDirectories}</td>
                  <td>{item.validJobRecords}</td>
                  <td><HealthStatusChip failed={item.missingJd > 0} /> {item.missingJd}</td>
                  <td>{item.emptyDirectories}</td>
                  <td>{item.exportOnlyDirectories}</td>
                  <td>{item.sampleOrphanDirectories.length > 0 ? item.sampleOrphanDirectories.join(', ') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="候选人漏斗" />
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>搜索</th>
                <th>新增</th>
                <th>简历</th>
                <th>已评分</th>
                <th>处理失败</th>
                <th>评分文件</th>
              </tr>
            </thead>
            <tbody>
              {health.candidateFunnels.map((item) => (
                <tr key={item.platform}>
                  <td><strong>{PLATFORM_LABELS[item.platform]}</strong></td>
                  <td>{item.totalCandidates}</td>
                  <td>{item.newCandidates}</td>
                  <td>{item.capturedResumes}</td>
                  <td>{item.scoredCandidates}</td>
                  <td><HealthStatusChip failed={item.failedCandidates > 0} /> {item.failedCandidates}</td>
                  <td>{item.scoreArtifacts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel health-wide">
        <SectionHeader title="登录与筛选健康" />
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>登录会话</th>
                <th>会话更新时间</th>
                <th>登录刷新</th>
                <th>筛选目录</th>
                <th>目录年龄</th>
                <th>异常字段</th>
              </tr>
            </thead>
            <tbody>
              {SINGLE_PLATFORM_OPTIONS.map((platform) => {
                const session = health.sessions.find((item) => item.platform === platform);
                const filter = health.filters.find((item) => item.platform === platform);
                const filterIssues = (filter?.failedControls ?? 0) + (filter?.unknownControls ?? 0);
                return (
                  <tr key={platform}>
                    <td><strong>{PLATFORM_LABELS[platform]}</strong></td>
                    <td><HealthStatusChip failed={!session?.exists} /> {session?.exists ? '存在' : '缺失'}</td>
                    <td>{formatDate(session?.updatedAt)}</td>
                    <td>{session?.recentLoginRefreshStatus ? <StatusChip status={session.recentLoginRefreshStatus} /> : '-'}</td>
                    <td>{filter?.exists ? `${filter.fieldCount} 字段` : '-'}</td>
                    <td>{formatHours(filter?.ageHours)}</td>
                    <td><HealthStatusChip failed={filterIssues > 0} /> {filterIssues}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MetricTile({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: string }) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function RecentTasksTable({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <div className="panel">
      <SectionHeader title="最近任务" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>类型</th>
              <th>平台</th>
              <th>关键词/文件</th>
              <th>更新时间</th>
              <th>输出</th>
            </tr>
          </thead>
          <tbody>
            {tasks.slice(0, 8).map((task) => (
              <tr key={task.taskId}>
                <td><StatusChip status={task.status} /></td>
                <td>{TASK_KIND_LABELS[task.kind]}</td>
                <td>{formatValue(task.inputSummary.platform)}</td>
                <td>{formatValue(task.inputSummary.keyword ?? task.inputSummary.jobsFile ?? task.inputSummary.searchSubscriptionFile ?? task.inputSummary.action)}</td>
                <td>{formatDate(task.updatedAt)}</td>
                <td>{formatValue(task.outputSummary?.jobKey ?? task.outputSummary?.storageStatePath ?? task.error)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TasksView() {
  const [tasksState, setTasksState] = useState<AsyncState<{ tasks: TaskSummary[] }>>({ loading: true });
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [detailState, setDetailState] = useState<AsyncState<TaskDetail>>({ loading: false });
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [kindFilter, setKindFilter] = useState<'all' | TaskKind>('all');

  const loadTasks = async () => {
    setTasksState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await api.listTasks();
      setTasksState({ data: result.data, mocked: result.mocked, loading: false });
      if (!selectedTaskId && result.data.tasks[0]) {
        setSelectedTaskId(result.data.tasks[0].taskId);
      }
    } catch (error) {
      setTasksState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void loadTasks();
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    setDetailState((current) => ({ ...current, loading: true, error: undefined }));
    api.getTask(selectedTaskId)
      .then((result) => setDetailState({ data: result.data, mocked: result.mocked, loading: false }))
      .catch((error) => setDetailState({ loading: false, error: error instanceof Error ? error.message : String(error) }));
  }, [selectedTaskId]);

  const tasks = tasksState.data?.tasks ?? [];
  const filteredTasks = tasks.filter((task) => (
    (statusFilter === 'all' || task.status === statusFilter)
    && (kindFilter === 'all' || task.kind === kindFilter)
  ));
  const taskMetrics = {
    running: tasks.filter((task) => task.status === 'queued' || task.status === 'running').length,
    succeeded: tasks.filter((task) => task.status === 'succeeded').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    total: tasks.length,
  };

  return (
    <div className="tasks-page">
      <section className="tasks-overview">
        <SectionHeader title="任务中心" action={<IconButton title="刷新" onClick={loadTasks}><RefreshCw size={18} /></IconButton>} />
        <div className="task-summary-strip">
          <MetricTile label="全部任务" value={taskMetrics.total} tone="neutral" icon={<ListChecks size={20} />} />
          <MetricTile label="排队/运行" value={taskMetrics.running} tone="active" icon={<Loader2 size={20} />} />
          <MetricTile label="成功" value={taskMetrics.succeeded} tone="success" icon={<CheckCircle2 size={20} />} />
          <MetricTile label="失败" value={taskMetrics.failed} tone={taskMetrics.failed > 0 ? 'danger' : 'success'} icon={<XCircle size={20} />} />
        </div>
      </section>

      <div className="tasks-layout">
        <section className="panel task-list-panel">
          <SectionHeader title="任务列表" />
          <MockNotice mocked={tasksState.mocked} />
          <ErrorBlock message={tasksState.error} />
          <div className="task-filters">
            <label>
              <span>状态</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | TaskStatus)}>
                <option value="all">全部状态</option>
                {(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as TaskStatus[]).map((status) => (
                  <option value={status} key={status}>{STATUS_LABELS[status]}</option>
                ))}
              </select>
            </label>
            <label>
              <span>类型</span>
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as 'all' | TaskKind)}>
                <option value="all">全部类型</option>
                {(Object.keys(TASK_KIND_LABELS) as TaskKind[]).map((kind) => (
                  <option value={kind} key={kind}>{TASK_KIND_LABELS[kind]}</option>
                ))}
              </select>
            </label>
          </div>
          {tasksState.loading && <LoadingBlock label="读取任务" />}
          {!tasksState.loading && filteredTasks.length === 0 && (
            <div className="empty-state">
              <FileQuestion size={18} />
              <span>没有符合条件的任务</span>
            </div>
          )}
          <div className="task-list">
            {filteredTasks.map((task) => {
              const target = formatValue(task.inputSummary.keyword ?? task.inputSummary.jobKey ?? task.inputSummary.jobsFile ?? task.inputSummary.searchSubscriptionFile ?? task.inputSummary.file ?? task.inputSummary.action);
              return (
                <button
                  type="button"
                  className={selectedTaskId === task.taskId ? 'task-row selected' : 'task-row'}
                  key={task.taskId}
                  onClick={() => setSelectedTaskId(task.taskId)}
                >
                  <div className="task-row-main">
                    <StatusChip status={task.status} />
                    <strong>{target}</strong>
                  </div>
                  <div className="task-row-meta">
                    <span>{TASK_KIND_LABELS[task.kind]}</span>
                    <span>{formatValue(task.inputSummary.platform ?? task.outputSummary?.platform ?? '-')}</span>
                    <time>{formatDate(task.updatedAt)}</time>
                  </div>
                  {task.error && <small>{task.error}</small>}
                </button>
              );
            })}
          </div>
        </section>
        <section className="panel detail-panel task-detail-panel">
          <SectionHeader title="任务详情" />
          {detailState.loading && <LoadingBlock />}
          <ErrorBlock message={detailState.error} />
          {detailState.data && (
            <div className="detail-stack">
              <div className="kv-grid task-kv-grid">
                <InfoCell label="任务 ID" value={detailState.data.taskId} />
                <InfoCell label="状态" value={<StatusChip status={detailState.data.status} />} />
                <InfoCell label="类型" value={TASK_KIND_LABELS[detailState.data.kind]} />
                <InfoCell label="创建时间" value={formatDate(detailState.data.createdAt)} />
                <InfoCell label="开始时间" value={formatDate(detailState.data.startedAt)} />
                <InfoCell label="结束时间" value={formatDate(detailState.data.finishedAt)} />
              </div>
              <div className="task-summary-panels">
                <section>
                  <h3>输入摘要</h3>
                  <JsonBlock value={detailState.data.inputSummary} />
                </section>
                <section>
                  <h3>输出摘要</h3>
                  <JsonBlock value={detailState.data.outputSummary ?? {}} />
                </section>
              </div>
              {detailState.data.error && <ErrorBlock message={detailState.data.error} />}
              <div className="log-section-header">
                <h3>运行日志</h3>
                <span>{detailState.data.logs.length} 条</span>
              </div>
              <div className="log-list">
                {detailState.data.logs.map((log) => (
                  <div className={`log-line log-${log.level}`} key={`${log.at}-${log.message}`}>
                    <time>{formatDate(log.at)}</time>
                    <span>{LOG_LEVEL_LABELS[log.level] ?? log.level}</span>
                    <p>{log.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="info-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type FilterBuilderValue =
  | string
  | { min?: string; max?: string }
  | { label: string; input: Record<string, string> }
  | { value: string; pathLabels: string[] };
type FilterBuilderValues = Record<string, FilterBuilderValue>;

function isRangeValue(value: FilterBuilderValue | undefined): value is { min?: string; max?: string } {
  return Boolean(value) && typeof value === 'object' && !('label' in value) && !('pathLabels' in value);
}

function isCustomInputValue(value: FilterBuilderValue | undefined): value is { label: string; input: Record<string, string> } {
  return Boolean(value) && typeof value === 'object' && 'label' in value;
}

function isTextPathValue(value: FilterBuilderValue | undefined): value is { value: string; pathLabels: string[] } {
  return Boolean(value) && typeof value === 'object' && 'pathLabels' in value;
}

function buildFilterInputPayload(fields: ApplicationFilterField[], values: FilterBuilderValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.fieldId];
    if (value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      if (value.trim()) {
        payload[field.fieldId] = value.trim();
      }
      continue;
    }

    if (isTextPathValue(value)) {
      if (value.value.trim()) {
        payload[field.fieldId] = {
          value: value.value.trim(),
          pathLabels: value.pathLabels,
        };
      }
      continue;
    }

    if (isCustomInputValue(value)) {
      const input = Object.fromEntries(Object.entries(value.input).filter(([, item]) => item.trim()));
      if (Object.keys(input).length > 0) {
        payload[field.fieldId] = {
          label: value.label,
          input,
        };
      }
      continue;
    }

    const range = Object.fromEntries(Object.entries(value).filter(([, item]) => item?.trim()));
    if (Object.keys(range).length > 0) {
      payload[field.fieldId] = range;
    }
  }

  return payload;
}

function formatFilterSelection(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  if ('pathLabels' in value && Array.isArray(value.pathLabels)) {
    return value.pathLabels.join(' / ');
  }

  if ('label' in value && typeof value.label === 'string') {
    const input = 'input' in value && value.input && typeof value.input === 'object'
      ? Object.values(value.input).filter(Boolean).join('-')
      : '';
    return input ? `${value.label} ${input}` : value.label;
  }

  const range = value as { min?: string; max?: string };
  if (range.min || range.max) {
    return `${range.min ?? '不限'} - ${range.max ?? '不限'}`;
  }

  return '';
}

function FilterBuilder({
  platform,
  onGenerated,
}: {
  platform: string;
  onGenerated: (path: string) => void;
}) {
  const [optionsState, setOptionsState] = useState<AsyncState<ApplicationFilterOptions>>({ loading: false });
  const [values, setValues] = useState<FilterBuilderValues>({});
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<AsyncState<SavedFilterInput>>({ loading: false });

  const loadOptions = async () => {
    if (platform === 'all') {
      setOptionsState({ loading: false, error: '筛选构建器需要先选择单个平台' });
      setValues({});
      setQueries({});
      setSaveState({ loading: false });
      return;
    }

    setOptionsState({ loading: true });
    setSaveState({ loading: false });
    try {
      const result = await api.getApplicationFilterOptions(platform);
      setOptionsState({ data: result.data, mocked: result.mocked, loading: false });
      setValues({});
      setQueries({});
    } catch (error) {
      setOptionsState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void loadOptions();
  }, [platform]);

  const fields = useMemo(() => {
    const options = optionsState.data;
    return options ? options.fieldIds.map((fieldId) => options.fieldsById[fieldId]).filter(Boolean) : [];
  }, [optionsState.data]);

  const applicationFilterInput = useMemo(() => buildFilterInputPayload(fields, values), [fields, values]);
  const selectedFilters = useMemo(() => fields
    .map((field) => ({
      field,
      label: formatFilterSelection(applicationFilterInput[field.fieldId]),
    }))
    .filter((item) => item.label), [applicationFilterInput, fields]);

  const setBuilderValue = (fieldId: string, value: FilterBuilderValue | undefined) => {
    setValues((current) => {
      const next = { ...current };
      if (value === undefined || (typeof value === 'string' && !value)) {
        delete next[fieldId];
      } else {
        next[fieldId] = value;
      }
      return next;
    });
  };

  const clearBuilderValue = (fieldId: string) => setBuilderValue(fieldId, undefined);

  const save = async () => {
    if (!optionsState.data || platform === 'all') {
      return;
    }

    if (Object.keys(applicationFilterInput).length === 0) {
      setSaveState({ loading: false, error: '至少选择一个筛选条件' });
      return;
    }

    setSaveState({ loading: true });
    try {
      const result = await api.saveApplicationFilterInput({
        platform,
        label: `${platform}-${optionsState.data.keyword}`,
        applicationFilterInput,
      });
      setSaveState({ data: result, loading: false });
      onGenerated(result.path);
    } catch (error) {
      setSaveState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const renderFieldFrame = (field: ApplicationFilterField, children: ReactNode) => {
    const selectedLabel = formatFilterSelection(applicationFilterInput[field.fieldId]);
    return (
      <div className={`platform-filter-row${selectedLabel ? ' has-value' : ''}`} key={field.fieldId}>
        <div className="filter-row-label">
          <span>{field.label}</span>
        </div>
        <div className="filter-row-controls">
          {children}
        </div>
        {selectedLabel && (
          <button
            className="filter-row-clear"
            type="button"
            title={`清除${field.label}`}
            aria-label={`清除${field.label}`}
            onClick={() => clearBuilderValue(field.fieldId)}
          >
            <X size={15} />
          </button>
        )}
      </div>
    );
  };

  const renderField = (field: ApplicationFilterField) => {
    const value = values[field.fieldId];
    if (field.kind === 'singleSelect') {
      const activeOptions = field.options.filter((option) => !option.disabled);
      const selected = isCustomInputValue(value) ? value.label : typeof value === 'string' ? value : '';
      const selectedOption = activeOptions.find((option) => option.value === selected || option.label === selected);
      const selectOption = (nextValue: string) => {
        const nextOption = activeOptions.find((option) => option.value === nextValue || option.label === nextValue);
        if (!nextValue || !nextOption) {
          clearBuilderValue(field.fieldId);
          return;
        }

        if (nextOption.inputSpec) {
          setBuilderValue(field.fieldId, { label: nextOption.label, input: {} });
        } else {
          setBuilderValue(field.fieldId, nextValue);
        }
      };
      return renderFieldFrame(field, (
        <>
          <div className="filter-option-strip">
            <button type="button" className={!selected ? 'active' : ''} onClick={() => clearBuilderValue(field.fieldId)}>不限</button>
            {activeOptions.slice(0, 10).map((option) => {
              const optionValue = option.value || option.label;
              return (
                <button
                  type="button"
                  className={selected === optionValue || selected === option.label ? 'active' : ''}
                  title={option.label}
                  onClick={() => selectOption(optionValue)}
                  key={`${field.fieldId}-quick-${option.label}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <label className="filter-select-label">
            <span>更多</span>
            <select value={selected} onChange={(event) => {
              const nextOption = activeOptions.find((option) => option.value === event.target.value || option.label === event.target.value);
              if (nextOption?.inputSpec) {
                setBuilderValue(field.fieldId, { label: nextOption.label, input: {} });
              } else {
                setBuilderValue(field.fieldId, event.target.value);
              }
            }}>
              <option value="">不设置</option>
              {activeOptions.map((option) => (
                <option value={option.value || option.label} key={`${field.fieldId}-${option.label}`}>{option.label}</option>
              ))}
            </select>
          </label>
          {selectedOption?.inputSpec && isCustomInputValue(value) && (
            <div className="filter-inline-inputs">
              {selectedOption.inputSpec.fields.map((inputField) => (
                <label key={inputField.key}>
                  <span>{inputField.label ?? inputField.placeholder ?? inputField.key}</span>
                  <input
                    value={value.input[inputField.key] ?? ''}
                    inputMode={inputField.valueType === 'number' ? 'numeric' : undefined}
                    onChange={(event) => setBuilderValue(field.fieldId, {
                      label: value.label,
                      input: {
                        ...value.input,
                        [inputField.key]: event.target.value,
                      },
                    })}
                  />
                </label>
              ))}
            </div>
          )}
        </>
      ));
    }

    if (field.kind === 'textInput') {
      const query = queries[field.fieldId] ?? '';
      const pathCandidates = field.tree.flatMap((node) => node.children.length > 0
        ? node.children.map((child) => ({
          label: child.label,
          value: child.value,
          pathLabels: child.pathLabels,
          display: child.pathLabels.join(' / '),
        }))
        : [{
          label: node.label,
          value: node.value,
          pathLabels: node.pathLabels,
          display: node.pathLabels.join(' / '),
        }]);
      const seenDisplays = new Set<string>();
      const candidates = (pathCandidates.length > 0
        ? pathCandidates
        : field.allowedValues.map((item) => ({ label: item, value: item, pathLabels: [] as string[], display: item })))
        .filter((item) => !query || item.display.toLowerCase().includes(query.toLowerCase()) || item.label.toLowerCase().includes(query.toLowerCase()))
        .filter((item) => {
          if (seenDisplays.has(item.display)) {
            return false;
          }
          seenDisplays.add(item.display);
            return true;
        })
        .slice(0, 80);
      const selectedValue = isTextPathValue(value) ? value.pathLabels.join('\u0000') : typeof value === 'string' ? value : '';
      const selectCandidate = (rawValue: string) => {
        const selected = candidates.find((item) => (item.pathLabels.length > 0 ? item.pathLabels.join('\u0000') : item.value) === rawValue);
        if (!selected) {
          clearBuilderValue(field.fieldId);
          return;
        }
        setBuilderValue(field.fieldId, selected.pathLabels.length > 0
          ? { value: selected.label, pathLabels: selected.pathLabels }
          : selected.value);
      };
      return renderFieldFrame(field, (
        <>
          <div className="filter-search-line">
            <label className="filter-search-input">
              <Search size={15} />
              <input value={query} onChange={(event) => setQueries((current) => ({ ...current, [field.fieldId]: event.target.value }))} placeholder={`搜索${field.label}`} />
            </label>
            <label className="filter-select-label compact">
              <span>选项</span>
              <select value={selectedValue} onChange={(event) => selectCandidate(event.target.value)}>
                <option value="">不设置</option>
                {candidates.map((item) => (
                  <option
                    value={item.pathLabels.length > 0 ? item.pathLabels.join('\u0000') : item.value}
                    key={`${field.fieldId}-${item.display}`}
                  >
                    {item.display}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="filter-option-strip text-options">
            <button type="button" className={!selectedValue ? 'active' : ''} onClick={() => clearBuilderValue(field.fieldId)}>不限</button>
            {candidates.slice(0, 8).map((item) => {
              const rawValue = item.pathLabels.length > 0 ? item.pathLabels.join('\u0000') : item.value;
              return (
                <button
                  type="button"
                  className={selectedValue === rawValue ? 'active' : ''}
                  title={item.display}
                  onClick={() => selectCandidate(rawValue)}
                  key={`${field.fieldId}-quick-${item.display}`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          {selectedValue && (
            <div className="selected-condition-line">
              <span>{formatFilterSelection(applicationFilterInput[field.fieldId])}</span>
            </div>
          )}
        </>
      ));
    }

    const range = isRangeValue(value) ? value : {};
    const unit = field.kind === 'numberRange' ? field.unit ?? '' : '';
    return renderFieldFrame(field, (
      <div className="filter-range-controls">
        <label>
          <span>{field.minLabel}</span>
          <select value={range.min ?? ''} onChange={(event) => setBuilderValue(field.fieldId, { ...range, min: event.target.value })}>
            <option value="">不限</option>
            {field.minOptions.map((item) => <option value={item} key={`${field.fieldId}-min-${item}`}>{item}{unit}</option>)}
          </select>
        </label>
        <span className="range-separator">-</span>
        <label>
          <span>{field.maxLabel}</span>
          <select value={range.max ?? ''} onChange={(event) => setBuilderValue(field.fieldId, { ...range, max: event.target.value })}>
            <option value="">不限</option>
            {field.maxOptions.map((item) => <option value={item} key={`${field.fieldId}-max-${item}`}>{item}{unit}</option>)}
          </select>
        </label>
      </div>
    ));
  };

  return (
    <section className={`panel filter-builder${optionsState.data ? ` platform-filter-builder platform-filter-${optionsState.data.platform}` : ''}`}>
      <SectionHeader title="平台筛选" action={<IconButton title="刷新筛选目录" onClick={loadOptions}><RefreshCw size={18} /></IconButton>} />
      <MockNotice mocked={optionsState.mocked} />
      <ErrorBlock message={optionsState.error ?? saveState.error} />
      {optionsState.loading && <LoadingBlock label="读取筛选目录" />}
      {optionsState.data && (
        <>
          <div className="builder-summary platform-filter-meta">
            <span>{PLATFORM_LABELS[optionsState.data.platform]} · {optionsState.data.fieldCount} 项筛选 · {formatDate(optionsState.data.capturedAt)}</span>
            <strong>{selectedFilters.length} 项已选</strong>
          </div>
          <div className="selected-filter-summary">
            {selectedFilters.length === 0 ? (
              <span className="empty-selected">未设置筛选条件</span>
            ) : selectedFilters.map((item) => (
              <button type="button" onClick={() => clearBuilderValue(item.field.fieldId)} key={`selected-${item.field.fieldId}`} title="点击清除">
                <span>{item.field.label}</span>
                <strong>{item.label}</strong>
                <X size={13} />
              </button>
            ))}
          </div>
          <div className="filter-panel">
            {fields.map(renderField)}
          </div>
          <div className="builder-preview">
            <JsonBlock value={applicationFilterInput} />
          </div>
          <div className="form-actions">
            <button className="primary-button" type="button" disabled={saveState.loading} onClick={save}>
              {saveState.loading ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
              生成 Filter File
            </button>
          </div>
          {saveState.data && (
            <div className="notice">
              <Database size={18} />
              <span>已生成：{saveState.data.path}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function JobsView({ navigate }: { navigate: (hash: string) => void }) {
  const [platform, setPlatform] = useState('all');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<AsyncState<{ jobs: JobSummary[] }>>({ loading: true });

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await api.listJobs(platform);
      setState({ data: result.data, mocked: result.mocked, loading: false });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void load();
  }, [platform]);

  const jobs = (state.data?.jobs ?? []).filter((job) => {
    const text = `${job.platform} ${job.jobKey} ${job.searchKeyword ?? ''} ${job.title ?? ''}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });
  const allJobs = state.data?.jobs ?? [];
  const jobMetrics = {
    total: allJobs.length,
    runs: allJobs.reduce((sum, job) => sum + job.runCount, 0),
    candidates: allJobs.reduce((sum, job) => sum + job.candidateCount, 0),
    scored: allJobs.reduce((sum, job) => sum + job.scoreCount, 0),
  };

  return (
    <div className="view-stack jobs-page">
      <SectionHeader title="历史岗位" action={<IconButton title="刷新" onClick={load}><RefreshCw size={18} /></IconButton>} />
      <MockNotice mocked={state.mocked} />
      <ErrorBlock message={state.error} />
      <div className="job-summary-strip">
        <MetricTile label="岗位" value={jobMetrics.total} tone="neutral" icon={<BriefcaseBusiness size={20} />} />
        <MetricTile label="运行次数" value={jobMetrics.runs} tone="active" icon={<ListChecks size={20} />} />
        <MetricTile label="候选人" value={jobMetrics.candidates} tone="success" icon={<UserRound size={20} />} />
        <MetricTile label="评分" value={jobMetrics.scored} tone="neutral" icon={<FileQuestion size={20} />} />
      </div>
      <section className="panel job-browser-panel">
        <div className="job-toolbar">
          <label>
            <span>平台</span>
            <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
              {FILTER_PLATFORM_OPTIONS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}
            </select>
          </label>
          <label className="search-box job-search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 jobKey、关键词、标题" />
          </label>
          <div className="job-result-count">
            <strong>{jobs.length}</strong>
            <span>个匹配岗位</span>
          </div>
        </div>
        {state.loading && <LoadingBlock label="读取岗位" />}
        {!state.loading && jobs.length === 0 && (
          <div className="empty-state">
            <BriefcaseBusiness size={18} />
            <span>没有符合条件的岗位</span>
          </div>
        )}
        <div className="job-card-list">
          {jobs.map((job) => (
            <article className="job-card" key={`${job.platform}-${job.jobKey}`}>
              <div className="job-card-main">
                <div className="job-card-title">
                  <span className={`platform-badge platform-${job.platform}`}>{PLATFORM_LABELS[job.platform]}</span>
                  <h3>{job.title ?? job.searchKeyword ?? job.jobKey}</h3>
                </div>
                <p>{job.jobKey}</p>
                <div className="job-card-meta">
                  <span>{job.location ?? '地点未记录'}</span>
                  <span>{job.searchKeyword ?? '无关键词'}</span>
                  <span>最近运行 {formatDate(job.latestRunAt)}</span>
                </div>
              </div>
              <div className="job-card-stats">
                <div><strong>{job.runCount}</strong><span>运行</span></div>
                <div><strong>{job.candidateCount}</strong><span>候选人</span></div>
                <div><strong>{job.scoreCount}</strong><span>评分</span></div>
              </div>
              <button className="text-button" type="button" onClick={() => navigate(jobHash(job))}>
                <ExternalLink size={16} />
                打开
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function JobDetailView({ platform, jobKey, navigate }: { platform: Platform; jobKey: string; navigate: (hash: string) => void }) {
  const [jobState, setJobState] = useState<AsyncState<JobDetail>>({ loading: true });
  const [candidateState, setCandidateState] = useState<AsyncState<{ candidates: CandidateSummary[] }>>({ loading: true });

  const load = async () => {
    setJobState((current) => ({ ...current, loading: true, error: undefined }));
    setCandidateState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const [job, candidates] = await Promise.all([api.getJob(platform, jobKey), api.listCandidates(platform, jobKey)]);
      setJobState({ data: job.data, mocked: job.mocked, loading: false });
      setCandidateState({ data: candidates.data, mocked: candidates.mocked, loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setJobState({ loading: false, error: message });
      setCandidateState({ loading: false, error: message });
    }
  };

  useEffect(() => {
    void load();
  }, [platform, jobKey]);

  const job = jobState.data;
  return (
    <div className="view-stack">
      <SectionHeader title={job?.title ?? jobKey} action={<IconButton title="刷新" onClick={load}><RefreshCw size={18} /></IconButton>} />
      <MockNotice mocked={jobState.mocked || candidateState.mocked} />
      <ErrorBlock message={jobState.error ?? candidateState.error} />
      {jobState.loading && !job && <LoadingBlock />}
      {job && (
        <>
          <section className="job-detail-hero">
            <div>
              <span className={`platform-badge platform-${job.platform}`}>{PLATFORM_LABELS[job.platform]}</span>
              <h2>{job.title ?? job.jobKey}</h2>
              <p>{job.searchKeyword ?? job.jobKey}</p>
            </div>
            <div className="job-detail-stats">
              <InfoCell label="运行次数" value={job.runCount} />
              <InfoCell label="候选人" value={job.candidateCount} />
              <InfoCell label="评分" value={job.scoreCount} />
            </div>
          </section>
          <div className="kv-grid">
            <InfoCell label="地点" value={job.location ?? '-'} />
            <InfoCell label="导出" value={job.exportPath ?? '-'} />
            <InfoCell label="邮件" value={job.recipientEmail ?? '-'} />
            <InfoCell label="抄送" value={job.ccEmails?.join(', ') || '-'} />
            <InfoCell label="最近运行" value={formatDate(job.latestRunAt)} />
            <InfoCell label="jobKey" value={job.jobKey} />
          </div>
          <div className="two-column">
            <section className="panel">
              <SectionHeader title="职位说明" />
              <div className="text-block">{job.rawText ?? '无 JD 文本'}</div>
            </section>
            <section className="panel">
              <SectionHeader title="结构化职位" />
              <JsonBlock value={job.normalizedJob ?? {}} />
            </section>
          </div>
          <div className="panel">
            <SectionHeader title="最近运行" />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>总候选</th>
                    <th>新增</th>
                    <th>已评分</th>
                    <th>失败</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{formatDate(job.latestRun?.fetchedAt)}</td>
                    <td>{job.latestRun?.totalCandidates ?? '-'}</td>
                    <td>{job.latestRun?.newCandidateIds.length ?? '-'}</td>
                    <td>{job.latestRun?.scoredCandidates.length ?? '-'}</td>
                    <td>{job.latestRun?.failedCandidates.length ?? '-'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <CandidateTable candidates={candidateState.data?.candidates ?? []} navigate={navigate} />
        </>
      )}
    </div>
  );
}

function CandidateTable({ candidates, navigate }: { candidates: CandidateSummary[]; navigate: (hash: string) => void }) {
  return (
    <div className="panel">
      <SectionHeader title="候选人" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>年龄</th>
              <th>学历</th>
              <th>地区</th>
              <th>当前经历</th>
              <th>评分</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.candidateId}>
                <td><strong>{candidate.name ?? candidate.candidateId}</strong></td>
                <td>{candidate.age ?? '-'}</td>
                <td>{candidate.education ?? '-'}</td>
                <td>{candidate.regions.join(', ') || '-'}</td>
                <td>{[candidate.currentCompany, candidate.currentTitle].filter(Boolean).join(' / ') || '-'}</td>
                <td>{candidate.score?.totalScore ?? <ScoreStatusChip status={candidate.score?.status} />}</td>
                <td>
                  <button className="text-button" type="button" onClick={() => navigate(candidateHash(candidate))}>
                    <UserRound size={16} />
                    查看
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CandidateDetailView({ platform, jobKey, candidateId }: { platform: Platform; jobKey: string; candidateId: string }) {
  const [state, setState] = useState<AsyncState<CandidateDetail>>({ loading: true });

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await api.getCandidate(platform, jobKey, candidateId);
      setState({ data: result.data, mocked: result.mocked, loading: false });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void load();
  }, [platform, jobKey, candidateId]);

  const candidate = state.data;
  return (
    <div className="view-stack">
      <SectionHeader title={candidate?.name ?? candidateId} action={<IconButton title="刷新" onClick={load}><RefreshCw size={18} /></IconButton>} />
      <MockNotice mocked={state.mocked} />
      <ErrorBlock message={state.error} />
      {state.loading && !candidate && <LoadingBlock />}
      {candidate && (
        <>
          <div className="kv-grid">
            <InfoCell label="候选人 ID" value={candidate.candidateId} />
            <InfoCell label="年龄" value={candidate.age ?? '-'} />
            <InfoCell label="学历" value={candidate.education ?? '-'} />
            <InfoCell label="地区" value={candidate.regions.join(', ') || '-'} />
            <InfoCell label="评分" value={candidate.score?.totalScore ?? <ScoreStatusChip status={candidate.score?.status} />} />
            <InfoCell label="Zhilian 分享链接" value={candidate.candidateShareUrl ?? '-'} />
          </div>
          <div className="two-column">
            <section className="panel">
              <SectionHeader title="简历结构" />
              <JsonBlock value={candidate.resume} />
            </section>
            <section className="panel">
              <SectionHeader title="评分文件" />
              <JsonBlock value={candidate.score?.artifact ?? candidate.score ?? {}} />
            </section>
          </div>
          <section className="panel">
            <SectionHeader title="原始快照" />
            <div className="path-line">{candidate.snapshotPath ?? '无快照'}</div>
            <pre className="snapshot-block">{candidate.snapshotPreview ?? ''}</pre>
          </section>
        </>
      )}
    </div>
  );
}

const ASSISTANT_KIND_LABELS: Record<AssistantActionKind, string> = {
  ...TASK_KIND_LABELS,
  'rag-answer': '候选人问答',
};

const ASSISTANT_QUICK_ACTIONS = [
  '帮我在猎聘搜索 Java 后端，筛选本科以上，3-5 年经验',
  '用这个岗位 JD 执行全部平台搜索',
  '刷新智联登录',
  '跑一下 51job 的搜索订阅',
  '检查 RAG 运维指标',
  '问一下这个岗位是否接受远程办公',
];

const MODEL_CONFIG_STORAGE_KEY = 'autorecruit.modelConfig';
const MODEL_CONFIG_SESSION_KEY = 'autorecruit.modelConfig.session';

function loadModelConfig(): ModelConfig {
  try {
    const raw = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY);
    const sessionRaw = window.sessionStorage.getItem(MODEL_CONFIG_SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<ModelConfig> : {};
    const sessionParsed = sessionRaw ? JSON.parse(sessionRaw) as Partial<ModelConfig> : {};
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      apiKey: typeof sessionParsed.apiKey === 'string' ? sessionParsed.apiKey : '',
    };
  } catch {
    return {};
  }
}

function persistModelConfig(config: ModelConfig): void {
  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify({
    baseUrl: config.baseUrl?.trim() || '',
    model: config.model?.trim() || '',
  }));
  window.sessionStorage.setItem(MODEL_CONFIG_SESSION_KEY, JSON.stringify({
    apiKey: config.apiKey?.trim() || '',
  }));
}

function buildModelConfig(config = loadModelConfig()): ModelConfig | undefined {
  const next: ModelConfig = {};
  if (config.baseUrl?.trim()) {
    next.baseUrl = config.baseUrl.trim();
  }
  if (config.model?.trim()) {
    next.model = config.model.trim();
  }
  if (config.apiKey?.trim()) {
    next.apiKey = config.apiKey.trim();
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

const ASSISTANT_DRAFT_FIELDS: Record<AssistantActionKind, Array<{ key: string; label: string; kind?: 'textarea' | 'checkbox' | 'number' | 'select'; options?: Array<{ value: string; label: string }> }>> = {
  'resume-capture': [
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(RUN_PLATFORM_OPTIONS) },
    { key: 'keyword', label: '关键词' },
    { key: 'jd', label: 'JD 文本', kind: 'textarea' },
    { key: 'jdFile', label: 'JD 文件路径' },
    { key: 'searchSource', label: '搜索来源', kind: 'select', options: [{ value: 'saved', label: SEARCH_SOURCE_LABELS.saved }, { value: 'direct', label: SEARCH_SOURCE_LABELS.direct }] },
    { key: 'applicationFilterInputFile', label: '筛选条件文件' },
    { key: 'includeViewed', label: '包含已查看', kind: 'checkbox' },
    { key: 'email', label: '收件邮箱' },
    { key: 'cc', label: '抄送邮箱' },
    { key: 'liepinForwardContact', label: '猎聘转发联系人' },
    { key: 'bossForwardMode', label: 'Boss 转发方式', kind: 'select', options: [{ value: 'colleague', label: '站内同事' }, { value: 'email', label: '邮件转发' }] },
    { key: 'bossForwardRecipient', label: 'Boss 转发收件人' },
  ],
  batch: [
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(RUN_PLATFORM_OPTIONS) },
    { key: 'jobsFile', label: '批量任务文件' },
    { key: 'searchSource', label: '搜索来源', kind: 'select', options: [{ value: 'saved', label: SEARCH_SOURCE_LABELS.saved }, { value: 'direct', label: SEARCH_SOURCE_LABELS.direct }] },
    { key: 'applicationFilterInputFile', label: '筛选条件文件' },
    { key: 'includeViewed', label: '包含已查看', kind: 'checkbox' },
    { key: 'email', label: '收件邮箱' },
    { key: 'cc', label: '抄送邮箱' },
    { key: 'liepinForwardContact', label: '猎聘转发联系人' },
    { key: 'bossForwardMode', label: 'Boss 转发方式', kind: 'select', options: [{ value: 'colleague', label: '站内同事' }, { value: 'email', label: '邮件转发' }] },
    { key: 'bossForwardRecipient', label: 'Boss 转发收件人' },
  ],
  'search-subscription': [
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(RUN_PLATFORM_OPTIONS) },
    { key: 'searchSubscriptionFile', label: '搜索订阅文件' },
    { key: 'keyword', label: '关键词' },
    { key: 'applicationFilterInputFile', label: '筛选条件文件' },
    { key: 'saveSearchSubscription', label: '保存搜索订阅', kind: 'checkbox' },
    { key: 'searchSubscriptionName', label: '订阅名称' },
  ],
  'login-refresh': [
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(SINGLE_PLATFORM_OPTIONS) },
  ],
  'rag-ops': [
    { key: 'action', label: '运维动作', kind: 'select', options: Object.entries(RAG_OPS_ACTION_LABELS).map(([value, label]) => ({ value, label })) },
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(SINGLE_PLATFORM_OPTIONS) },
    { key: 'jobKey', label: '岗位 Key' },
    { key: 'keyword', label: '关键词' },
    { key: 'question', label: '诊断问题' },
    { key: 'file', label: '岗位列表文件' },
    { key: 'policyFile', label: '策略文件' },
    { key: 'reviewer', label: '复核人' },
    { key: 'limit', label: '条数上限', kind: 'number' },
    { key: 'includeReviewed', label: '包含已复核', kind: 'checkbox' },
    { key: 'failOnIssue', label: '发现问题时失败', kind: 'checkbox' },
  ],
  'rag-answer': [
    { key: 'platform', label: '平台', kind: 'select', options: platformSelectOptions(SINGLE_PLATFORM_OPTIONS) },
    { key: 'jobKey', label: '岗位 Key' },
    { key: 'keyword', label: '关键词' },
    { key: 'jd', label: '临时 JD 文本', kind: 'textarea' },
    { key: 'jdFile', label: '临时 JD 文件' },
    { key: 'question', label: '问题', kind: 'textarea' },
    { key: 'topK', label: '召回数量', kind: 'number' },
    { key: 'autoIndex', label: '自动建索引', kind: 'checkbox' },
    { key: 'logAnswer', label: '记录回答', kind: 'checkbox' },
  ],
};

function assistantDraftCanConfirm(draft?: AssistantDraft): boolean {
  if (!draft || !draft.input.platform) {
    return false;
  }

  const input = draft.input;
  if (draft.kind === 'resume-capture') {
    return Boolean(input.keyword && (input.jd || input.jdFile));
  }
  if (draft.kind === 'batch') {
    return Boolean(input.jobsFile);
  }
  if (draft.kind === 'search-subscription') {
    return Boolean(input.searchSubscriptionFile);
  }
  if (draft.kind === 'rag-ops') {
    if (!input.action) {
      return false;
    }
    if ((input.action === 'doctor' || input.action === 'review' || input.action === 'rebuild') && !input.jobKey && !input.keyword) {
      return false;
    }
    if ((input.action === 'metrics' || input.action === 'ops') && !input.file) {
      return false;
    }
  }
  if (draft.kind === 'rag-answer') {
    return Boolean(input.question && (input.jobKey || input.keyword || input.jd || input.jdFile));
  }

  return true;
}

function hasAssistantRisk(draft?: AssistantDraft): boolean {
  return Boolean(draft?.warnings.some((warning) => warning.startsWith('风险：')));
}

function AssistantView({ navigate }: { navigate: (hash: string) => void }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      role: 'assistant',
      content: '请用中文描述要执行的招聘自动化操作。我会先生成任务草稿，确认前不会执行。',
      createdAt: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<AssistantDraft>();
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [chatState, setChatState] = useState<AsyncState<unknown>>({ loading: false });
  const [confirmState, setConfirmState] = useState<AsyncState<AssistantConfirmResponse>>({ loading: false });

  const applyAssistantResponse = (response: Awaited<ReturnType<typeof api.chatWithAssistant>>) => {
    setMessages((current) => [...current, response.message]);
    if (response.draft) {
      setDraft(response.draft);
      setRiskAccepted(false);
    }
    setChatState({ loading: false });
  };

  const submitText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatState.loading) {
      return;
    }

    const userMessage: AssistantMessage = {
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setChatState({ loading: true });
    setConfirmState({ loading: false });

    try {
      applyAssistantResponse(await api.chatWithAssistant({
        messages: nextMessages,
        draft,
        modelConfig: buildModelConfig(),
      }));
    } catch (error) {
      setChatState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submitText(input);
  };

  const updateDraftInput = (field: string, value: unknown) => {
    if (!draft) {
      return;
    }

    setDraft({
      ...draft,
      input: {
        ...draft.input,
        [field]: value,
      },
    });
    setRiskAccepted(false);
  };

  const validateDraft = async () => {
    if (!draft) {
      return;
    }

    setChatState({ loading: true });
    try {
      const response = await api.validateAssistantDraft(draft);
      setMessages((current) => [...current, response.message]);
      if (response.draft) {
        setDraft(response.draft);
      }
      setRiskAccepted(false);
      setChatState({ loading: false });
    } catch (error) {
      setChatState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const confirmDraft = async () => {
    if (!draft) {
      return;
    }

    setConfirmState({ loading: true });
    try {
      const result = await api.confirmAssistantDraft(draft, riskAccepted);
      setConfirmState({ data: result, loading: false });
    } catch (error) {
      setConfirmState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const canConfirm = assistantDraftCanConfirm(draft) && (!hasAssistantRisk(draft) || riskAccepted);

  return (
    <div className="assistant-page">
      <section className="assistant-chat-panel panel">
        <SectionHeader title="智能助手" />
        <ModelConfigStatus />
        <div className="assistant-quick-actions">
          {ASSISTANT_QUICK_ACTIONS.map((item) => (
            <button type="button" key={item} onClick={() => void submitText(item)} disabled={chatState.loading}>
              {item}
            </button>
          ))}
        </div>
        <div className="assistant-message-list">
          {messages.map((message, index) => (
            <div className={`assistant-message ${message.role}`} key={`${message.createdAt ?? index}-${index}`}>
              <div className="assistant-message-meta">
                <span>{message.role === 'user' ? '你' : '助手'}</span>
                <time>{formatDate(message.createdAt)}</time>
              </div>
              <p>{message.content}</p>
            </div>
          ))}
          {chatState.loading && (
            <div className="assistant-message assistant">
              <div className="assistant-message-meta"><span>助手</span></div>
              <p><Loader2 className="spin" size={16} /> 正在处理</p>
            </div>
          )}
        </div>
        <ErrorBlock message={chatState.error} />
        <form className="assistant-input-row" onSubmit={submit}>
          <label>
            <span>输入需求</span>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={3} placeholder="例如：帮我在猎聘搜索 Java 后端，筛选本科以上，3-5 年经验" />
          </label>
          <button className="primary-button" type="submit" disabled={chatState.loading || !input.trim()}>
            {chatState.loading ? <Loader2 className="spin" size={17} /> : <MessageSquareText size={17} />}
            生成草稿
          </button>
        </form>
      </section>

      <section className="assistant-draft-panel panel">
        <SectionHeader title="任务草稿" />
        {!draft && (
          <div className="empty-state">
            <Sparkles size={18} />
            <span>发送需求后会在这里生成可编辑草稿。</span>
          </div>
        )}
        {draft && (
          <>
            <AssistantDraftSummary draft={draft} />
            <AssistantDraftEditor draft={draft} onChange={updateDraftInput} />
            <div className="assistant-draft-actions">
              <button className="text-button" type="button" onClick={validateDraft} disabled={chatState.loading}>
                {chatState.loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                重新校验
              </button>
              {hasAssistantRisk(draft) && (
                <label className="checkbox-row assistant-risk-check">
                  <input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />
                  <span>我已确认风险提示</span>
                </label>
              )}
              <button className="primary-button" type="button" onClick={confirmDraft} disabled={!canConfirm || confirmState.loading}>
                {confirmState.loading ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
                确认执行
              </button>
            </div>
          </>
        )}
        <ErrorBlock message={confirmState.error} />
        {confirmState.data && (
          <AssistantConfirmResult result={confirmState.data} navigate={navigate} />
        )}
      </section>
    </div>
  );
}

function ModelConfigStatus() {
  const config = loadModelConfig();
  return (
    <div className="model-config-status">
      <span>模型配置</span>
      <strong>{config.model?.trim() || '服务端默认模型'}</strong>
      <small>{config.baseUrl?.trim() || '服务端默认中转地址'} / {config.apiKey?.trim() ? '已填写 API Key' : '服务端默认 API Key'}</small>
      <a href="#/settings">编辑配置</a>
    </div>
  );
}

function SettingsView() {
  const [config, setConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [savedAt, setSavedAt] = useState<string>();

  const update = (field: keyof ModelConfig, value: string) => {
    setConfig((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    persistModelConfig(config);
    setSavedAt(new Date().toISOString());
  };

  return (
    <div className="view-stack">
      <SectionHeader title="配置" />
      <form className="panel settings-form" onSubmit={save}>
        <div className="settings-form-header">
          <div>
            <h2>模型调用</h2>
            <p>用于智能助手生成草稿和控制台 RAG 问答。确认后的抓取任务仍使用各自运行时配置。</p>
          </div>
          <button className="primary-button" type="submit">
            <Save size={17} />
            保存配置
          </button>
        </div>
        <div className="settings-grid">
          <label>
            <span>中转地址</span>
            <input value={config.baseUrl ?? ''} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" />
          </label>
          <label>
            <span>模型名称</span>
            <input value={config.model ?? ''} onChange={(event) => update('model', event.target.value)} placeholder="留空使用服务端 OPENAI_MODEL/RAG_MODEL" autoComplete="off" />
          </label>
          <label>
            <span>API Key</span>
            <input value={config.apiKey ?? ''} onChange={(event) => update('apiKey', event.target.value)} placeholder="留空使用服务端 OPENAI_API_KEY" type="password" autoComplete="off" />
          </label>
        </div>
        <div className="settings-note">
          中转地址和模型名称保存在浏览器本地；API Key 只保存在当前浏览器会话。提交智能助手和 RAG 问答时会随请求发送到本地控制台 API，不写入任务队列。
        </div>
        {savedAt && (
          <div className="assistant-result notice">
            <CheckCircle2 size={18} />
            <span>已保存：{formatDate(savedAt)}</span>
          </div>
        )}
      </form>
    </div>
  );
}

function AssistantDraftSummary({ draft }: { draft: AssistantDraft }) {
  const input = draft.input;
  return (
    <div className="assistant-summary">
      <div className="assistant-kind-line">
        <span className="status-chip status-neutral">{ASSISTANT_KIND_LABELS[draft.kind]}</span>
        <strong>{formatValue(input.keyword ?? input.jobKey ?? input.jobsFile ?? input.searchSubscriptionFile ?? input.action ?? input.platform)}</strong>
      </div>
      <div className="kv-grid assistant-kv-grid">
        <InfoCell label="平台" value={formatValue(input.platform)} />
        <InfoCell label="关键词/岗位" value={formatValue(input.keyword ?? input.jobKey)} />
        <InfoCell label="JD 输入" value={input.jd ? 'JD 文本' : input.jdFile ? String(input.jdFile) : '-'} />
        <InfoCell label="搜索来源" value={formatValue(input.searchSource ?? '-')} />
        <InfoCell label="包含已查看" value={input.includeViewed === true ? '是' : '否'} />
        <InfoCell label="邮件" value={formatValue(input.email ?? input.cc)} />
      </div>
      {draft.missingFields.length > 0 && (
        <div className="assistant-alert danger">
          <AlertTriangle size={17} />
          <span>缺失字段：{draft.missingFields.join('、')}</span>
        </div>
      )}
      {draft.warnings.length > 0 && (
        <div className="assistant-warning-list">
          {draft.warnings.map((warning) => (
            <div className={warning.startsWith('风险：') ? 'assistant-alert danger' : 'assistant-alert'} key={warning}>
              <AlertTriangle size={17} />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
      {draft.argvPreview && draft.argvPreview.length > 0 && (
        <div className="assistant-argv">
          <span>预计 CLI 参数</span>
          <code>{draft.argvPreview.join(' ')}</code>
        </div>
      )}
    </div>
  );
}

function AssistantDraftEditor({ draft, onChange }: { draft: AssistantDraft; onChange: (field: string, value: unknown) => void }) {
  return (
    <div className="assistant-editor">
      {ASSISTANT_DRAFT_FIELDS[draft.kind].map((field) => {
        const value = draft.input[field.key];
        if (field.kind === 'checkbox') {
          return (
            <label className="checkbox-row" key={field.key}>
              <input type="checkbox" checked={value === true} onChange={(event) => onChange(field.key, event.target.checked)} />
              <span>{field.label}</span>
            </label>
          );
        }

        if (field.kind === 'textarea') {
          return (
            <label className="wide" key={field.key}>
              <span>{field.label}</span>
              <textarea value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(field.key, event.target.value)} rows={field.key === 'jd' ? 5 : 3} />
            </label>
          );
        }

        if (field.kind === 'select') {
          return (
            <label key={field.key}>
              <span>{field.label}</span>
              <select value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(field.key, event.target.value)}>
                <option value="">不设置</option>
                {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          );
        }

        return (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              value={Array.isArray(value) ? value.join(',') : value === undefined || value === null ? '' : String(value)}
              inputMode={field.kind === 'number' ? 'numeric' : undefined}
              onChange={(event) => {
                const raw = event.target.value;
                if (field.key === 'cc') {
                  onChange(field.key, raw.split(',').map((item) => item.trim()).filter(Boolean));
                  return;
                }
                if (field.kind === 'number') {
                  onChange(field.key, raw ? Number(raw) : undefined);
                  return;
                }
                onChange(field.key, raw);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

function AssistantConfirmResult({ result, navigate }: { result: AssistantConfirmResponse; navigate: (hash: string) => void }) {
  if (result.kind === 'rag-answer') {
    return (
      <div className="assistant-result">
        <div className={result.answer.answered === false ? 'answer-block no-answer' : 'answer-block'}>
          <strong>{result.answer.answered === false ? '未找到可信答案' : '已回答'}</strong>
          <p>{result.answer.answer}</p>
          <span>置信度：{result.answer.confidence ?? '-'}</span>
          {result.answer.noAnswerReason && <span>原因：{result.answer.noAnswerReason}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="assistant-result notice">
      <CheckCircle2 size={18} />
      <span>已创建任务：{result.task.taskId} / {STATUS_LABELS[result.task.status]}</span>
      <button className="text-button" type="button" onClick={() => navigate('#/tasks')}>查看任务</button>
    </div>
  );
}

function RunJobView() {
  const [mode, setMode] = useState<'resume-capture' | 'batch' | 'search-subscription'>('resume-capture');
  const [form, setForm] = useState({
    platform: '51job',
    keyword: '',
    jd: '',
    jdFile: '',
    jobsFile: '',
    searchSubscriptionFile: '',
    includeViewed: false,
    searchSource: 'saved',
    applicationFilterInputFile: '',
    email: '',
    cc: '',
    liepinForwardContact: '',
    bossForwardMode: '',
    bossForwardRecipient: '',
    saveSearchSubscription: false,
    searchSubscriptionName: '',
  });
  const [submitState, setSubmitState] = useState<AsyncState<TaskDetail>>({ loading: false });

  const setField = (field: keyof typeof form, value: string | boolean) => setForm((current) => ({
    ...current,
    [field]: value,
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitState({ loading: true });
    const common = {
      platform: form.platform,
      includeViewed: form.includeViewed,
      searchSource: form.searchSource,
      applicationFilterInputFile: form.searchSource === 'direct' ? form.applicationFilterInputFile || undefined : undefined,
      email: form.email || undefined,
      cc: form.cc || undefined,
      liepinForwardContact: form.platform === 'liepin' || form.platform === 'all' ? form.liepinForwardContact || undefined : undefined,
      bossForwardMode: form.platform === 'boss' ? form.bossForwardMode || undefined : undefined,
      bossForwardRecipient: form.platform === 'boss' && form.bossForwardMode ? form.bossForwardRecipient || undefined : undefined,
    };
    const body = mode === 'resume-capture'
      ? {
        ...common,
        keyword: form.keyword,
        jd: form.jd || undefined,
        jdFile: form.jdFile || undefined,
      }
      : mode === 'batch'
        ? {
          ...common,
          jobsFile: form.jobsFile,
        }
        : {
          platform: form.platform,
          searchSubscriptionFile: form.searchSubscriptionFile,
          keyword: form.keyword || undefined,
          applicationFilterInputFile: form.applicationFilterInputFile || undefined,
          saveSearchSubscription: form.saveSearchSubscription,
          searchSubscriptionName: form.searchSubscriptionName || undefined,
        };

    try {
      setSubmitState({ data: await api.submitTask(mode, body), loading: false });
    } catch (error) {
      setSubmitState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="view-stack">
      <SectionHeader title="提交任务" />
      <form className="run-job-panel" onSubmit={submit}>
        <div className="run-mode-bar">
          {([
            ['resume-capture', '简历抓取'],
            ['batch', '批量任务'],
            ['search-subscription', '搜索订阅'],
          ] as const).map(([item, label]) => (
            <button type="button" className={mode === item ? 'active' : ''} key={item} onClick={() => setMode(item)}>
              {label}
            </button>
          ))}
        </div>

        <div className="run-job-layout">
          <section className="run-job-column">
            <div className="form-section-title">
              <span>执行范围</span>
              <strong>{mode === 'resume-capture' ? '抓取' : mode === 'batch' ? '批量' : '订阅'}</strong>
            </div>
            <label>
              <span>平台</span>
              <select value={form.platform} onChange={(event) => setField('platform', event.target.value)}>
                {RUN_PLATFORM_OPTIONS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}
              </select>
              <small>{ALL_PLATFORM_NOTE}</small>
            </label>
            {mode !== 'batch' && (
              <label>
                <span>关键词</span>
                <input value={form.keyword} onChange={(event) => setField('keyword', event.target.value)} placeholder="例如：泰国 零售 运营" />
              </label>
            )}
            {mode === 'batch' && (
              <label>
                <span>批量任务文件</span>
                <input value={form.jobsFile} onChange={(event) => setField('jobsFile', event.target.value)} placeholder="./jobs.json" />
              </label>
            )}
            {mode === 'search-subscription' && (
              <>
                <label>
                  <span>订阅文件</span>
                  <input value={form.searchSubscriptionFile} onChange={(event) => setField('searchSubscriptionFile', event.target.value)} placeholder="./search-subscription.json" />
                </label>
                <label>
                  <span>订阅名称</span>
                  <input value={form.searchSubscriptionName} onChange={(event) => setField('searchSubscriptionName', event.target.value)} />
                </label>
                <label>
                  <span>筛选条件文件</span>
                  <input value={form.applicationFilterInputFile} onChange={(event) => setField('applicationFilterInputFile', event.target.value)} placeholder="./filter-input.json" />
                </label>
              </>
            )}
          </section>

          <section className="run-job-column run-job-primary">
            <div className="form-section-title">
              <span>{mode === 'resume-capture' ? '职位输入' : mode === 'batch' ? '执行选项' : '订阅选项'}</span>
              <strong>{mode === 'resume-capture' ? '职位说明' : '选项'}</strong>
            </div>
            {mode === 'resume-capture' && (
              <>
                <label>
                  <span>JD 文本</span>
                  <textarea value={form.jd} onChange={(event) => setField('jd', event.target.value)} rows={6} />
                </label>
                <label>
                  <span>JD 文件</span>
                  <input value={form.jdFile} onChange={(event) => setField('jdFile', event.target.value)} placeholder="./fixtures/jd.txt" />
                </label>
              </>
            )}
            {mode !== 'search-subscription' && (
              <>
                <label>
                  <span>搜索来源</span>
                  <select value={form.searchSource} onChange={(event) => setField('searchSource', event.target.value)}>
                    <option value="saved">{SEARCH_SOURCE_LABELS.saved}</option>
                    <option value="direct">{SEARCH_SOURCE_LABELS.direct}</option>
                  </select>
                </label>
                {form.searchSource === 'direct' && (
                  <label>
                    <span>筛选条件文件</span>
                    <input value={form.applicationFilterInputFile} onChange={(event) => setField('applicationFilterInputFile', event.target.value)} placeholder="./filter-input.json" />
                  </label>
                )}
              </>
            )}
            {mode === 'search-subscription' && (
              <label className="checkbox-row">
                <input type="checkbox" checked={form.saveSearchSubscription} onChange={(event) => setField('saveSearchSubscription', event.target.checked)} />
                <span>保存搜索订阅</span>
              </label>
            )}
          </section>
        </div>

        {mode !== 'search-subscription' && (
          <section className="run-advanced">
            <div className="form-section-title">
              <span>通知与附加动作</span>
              <strong>可选</strong>
            </div>
            <div className="run-advanced-grid">
              <label>
                <span>收件邮箱</span>
                <input value={form.email} onChange={(event) => setField('email', event.target.value)} />
              </label>
              <label>
                <span>抄送邮箱</span>
                <input value={form.cc} onChange={(event) => setField('cc', event.target.value)} />
              </label>
              {(form.platform === 'liepin' || form.platform === 'all') && (
                <label>
                  <span>猎聘转发联系人</span>
                  <input value={form.liepinForwardContact} onChange={(event) => setField('liepinForwardContact', event.target.value)} />
                </label>
              )}
              {form.platform === 'boss' && (
                <label>
                  <span>Boss 转发方式</span>
                  <select value={form.bossForwardMode} onChange={(event) => setField('bossForwardMode', event.target.value)}>
                    <option value="">不转发</option>
                    <option value="colleague">站内同事</option>
                    <option value="email">邮件转发</option>
                  </select>
                </label>
              )}
              {form.platform === 'boss' && form.bossForwardMode && (
                <label>
                  <span>{form.bossForwardMode === 'colleague' ? '站内同事姓名' : '收件人邮箱'}</span>
                  <input
                    value={form.bossForwardRecipient}
                    onChange={(event) => setField('bossForwardRecipient', event.target.value)}
                    placeholder={form.bossForwardMode === 'colleague' ? '输入姓名并由任务选择匹配项' : 'name@example.com'}
                  />
                </label>
              )}
              <label className="checkbox-row">
                <input type="checkbox" checked={form.includeViewed} onChange={(event) => setField('includeViewed', event.target.checked)} />
                <span>包含已查看候选人</span>
              </label>
            </div>
          </section>
        )}

        <div className="run-submit-row">
          <span>{form.searchSource === 'direct' && mode !== 'search-subscription'
            ? '直接搜索会使用下方筛选条件文件。'
            : mode === 'search-subscription' && form.applicationFilterInputFile
              ? '搜索订阅会把筛选条件写入临时订阅文件后执行。'
              : '提交后任务进入队列执行。'}</span>
          <button className="primary-button" type="submit" disabled={submitState.loading}>
            {submitState.loading ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            提交
          </button>
        </div>
      </form>
      <ErrorBlock message={submitState.error} />
      {submitState.data && (
        <section className="panel">
          <SectionHeader title="已创建任务" />
          <div className="kv-grid">
            <InfoCell label="任务 ID" value={submitState.data.taskId} />
            <InfoCell label="状态" value={<StatusChip status={submitState.data.status} />} />
            <InfoCell label="类型" value={TASK_KIND_LABELS[submitState.data.kind]} />
            <InfoCell label="创建时间" value={formatDate(submitState.data.createdAt)} />
          </div>
        </section>
      )}
      {((mode !== 'search-subscription' && form.searchSource === 'direct') || mode === 'search-subscription') && (
        <FilterBuilder
          platform={form.platform}
          onGenerated={(filePath) => setField('applicationFilterInputFile', filePath)}
        />
      )}
    </div>
  );
}

function RagView() {
  const [mode, setMode] = useState<'stored' | 'temporary-jd'>('stored');
  const [form, setForm] = useState({
    platform: '51job',
    jobKey: '',
    keyword: '',
    jd: '',
    jdFile: '',
    question: '',
    topK: '5',
    autoIndex: true,
    logAnswer: true,
  });
  const [state, setState] = useState<AsyncState<RagAnswer>>({ loading: false });
  const setField = (field: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ loading: true });
    if (mode === 'temporary-jd') {
      if (form.jd && form.jdFile) {
        setState({ loading: false, error: 'JD 文本和 JD 文件不能同时填写' });
        return;
      }

      if (!form.jd && !form.jdFile) {
        setState({ loading: false, error: '临时 JD 问答需要 JD 文本或 JD 文件' });
        return;
      }
    }

    try {
      setState({
        data: await api.askRag({
          ...(mode === 'temporary-jd'
            ? {
              platform: form.platform,
              jobKey: form.jobKey || undefined,
              keyword: form.keyword || undefined,
              jd: form.jd || undefined,
              jdFile: form.jdFile || undefined,
              question: form.question,
            }
            : {
              platform: form.platform,
              jobKey: form.jobKey || undefined,
              keyword: form.keyword || undefined,
              question: form.question,
              topK: Number(form.topK),
              autoIndex: form.autoIndex,
              logAnswer: form.logAnswer,
            }),
          modelConfig: buildModelConfig(),
        }),
        loading: false,
      });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="view-stack">
      <SectionHeader title="候选人问答" />
      <form className="panel form-grid" onSubmit={submit}>
        <div className="segmented">
          {([
            ['stored', '已存岗位'],
            ['temporary-jd', '临时职位说明'],
          ] as const).map(([item, label]) => (
            <button type="button" className={mode === item ? 'active' : ''} key={item} onClick={() => setMode(item)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          <span>平台</span>
          <select value={form.platform} onChange={(event) => setField('platform', event.target.value)}>
            {SINGLE_PLATFORM_OPTIONS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}
          </select>
        </label>
        <label>
          <span>岗位 Key</span>
          <input value={form.jobKey} onChange={(event) => setField('jobKey', event.target.value)} />
        </label>
        <label>
          <span>关键词</span>
          <input value={form.keyword} onChange={(event) => setField('keyword', event.target.value)} />
        </label>
        {mode === 'stored' && (
          <label>
            <span>召回数量</span>
            <input value={form.topK} onChange={(event) => setField('topK', event.target.value)} inputMode="numeric" />
          </label>
        )}
        {mode === 'temporary-jd' && (
          <>
            <label className="wide">
              <span>JD 文本</span>
              <textarea value={form.jd} onChange={(event) => setField('jd', event.target.value)} rows={5} />
            </label>
            <label>
              <span>JD 文件</span>
              <input value={form.jdFile} onChange={(event) => setField('jdFile', event.target.value)} placeholder="./fixtures/jd.txt" />
            </label>
          </>
        )}
        <label className="wide">
          <span>问题</span>
          <textarea value={form.question} onChange={(event) => setField('question', event.target.value)} rows={4} />
        </label>
        {mode === 'stored' && (
          <>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.autoIndex} onChange={(event) => setField('autoIndex', event.target.checked)} />
              <span>自动建索引</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.logAnswer} onChange={(event) => setField('logAnswer', event.target.checked)} />
              <span>记录回答</span>
            </label>
          </>
        )}
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={state.loading}>
            {state.loading ? <Loader2 className="spin" size={17} /> : <FileQuestion size={17} />}
            提问
          </button>
        </div>
      </form>
      <ErrorBlock message={state.error} />
      {state.data && (
        <section className="panel">
          <SectionHeader title="回答结果" />
          <div className={state.data.answered === false ? 'answer-block no-answer' : 'answer-block'}>
            <strong>{state.data.answered === false ? '未找到可信答案' : '已回答'}</strong>
            <p>{state.data.answer}</p>
            {state.data.temporary && <span>临时职位说明回答</span>}
            <span>置信度：{state.data.confidence ?? '-'}</span>
            {state.data.noAnswerReason && <span>原因：{state.data.noAnswerReason}</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>类型</th>
                  <th>分数</th>
                  <th>已验证</th>
                  <th>文本</th>
                </tr>
              </thead>
              <tbody>
                {state.data.sources.map((source, index) => (
                  <tr key={source.chunkId ?? source.id ?? index}>
                    <td>{source.label}</td>
                    <td>{source.sourceType ?? '职位说明'}</td>
                    <td>{source.score.toFixed(3)}</td>
                    <td>{source.verified === undefined ? '-' : source.verified ? '是' : '否'}</td>
                    <td className="long-text">{source.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function OpsView() {
  const [platform, setPlatform] = useState('all');
  const [state, setState] = useState<AsyncState<{ catalogs: FilterCatalog[] }>>({ loading: true });
  const [loginRefreshState, setLoginRefreshState] = useState<AsyncState<TaskDetail>>({ loading: false });
  const [loginRefreshPlatform, setLoginRefreshPlatform] = useState<Platform>();
  const [ragOpsForm, setRagOpsForm] = useState({
    action: 'doctor',
    platform: '51job',
    keyword: '',
    jobKey: '',
    question: '',
    file: '',
    policyFile: '',
    reviewer: '',
    limit: '',
    includeReviewed: false,
    failOnIssue: false,
  });
  const [ragOpsState, setRagOpsState] = useState<AsyncState<TaskDetail>>({ loading: false });

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await api.listFilterCatalogs(platform);
      setState({ data: result.data, mocked: result.mocked, loading: false });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void load();
  }, [platform]);

  const refreshLogin = async (targetPlatform: Platform) => {
    setLoginRefreshPlatform(targetPlatform);
    setLoginRefreshState({ loading: true });
    try {
      const task = await api.submitTask('login-refresh', { platform: targetPlatform });
      setLoginRefreshState({ data: task, loading: false });
    } catch (error) {
      setLoginRefreshState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const setRagOpsField = (field: keyof typeof ragOpsForm, value: string | boolean) => setRagOpsForm((current) => ({
    ...current,
    [field]: value,
  }));

  const submitRagOps = async (event: FormEvent) => {
    event.preventDefault();
    setRagOpsState({ loading: true });
    const body: Record<string, unknown> = {
      action: ragOpsForm.action,
    };
    if (ragOpsForm.action === 'doctor' || ragOpsForm.action === 'review' || ragOpsForm.action === 'rebuild') {
      body.platform = ragOpsForm.platform;
      body.keyword = ragOpsForm.keyword || undefined;
      body.jobKey = ragOpsForm.jobKey || undefined;
    }
    if (ragOpsForm.action === 'doctor' || ragOpsForm.action === 'ops') {
      body.question = ragOpsForm.question || undefined;
    }
    if (ragOpsForm.action === 'metrics' || ragOpsForm.action === 'ops') {
      body.file = ragOpsForm.file || undefined;
      body.policyFile = ragOpsForm.policyFile || undefined;
    }
    if (ragOpsForm.action === 'review' || ragOpsForm.action === 'ops') {
      body.reviewer = ragOpsForm.reviewer || undefined;
      body.includeReviewed = ragOpsForm.includeReviewed;
      body.limit = ragOpsForm.limit ? Number(ragOpsForm.limit) : undefined;
    }
    if (ragOpsForm.action === 'ops') {
      body.failOnIssue = ragOpsForm.failOnIssue;
    }

    try {
      setRagOpsState({ data: await api.submitTask('rag-ops', body), loading: false });
    } catch (error) {
      setRagOpsState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const isSingleJobRagAction = ragOpsForm.action === 'doctor' || ragOpsForm.action === 'review' || ragOpsForm.action === 'rebuild';
  const isBatchRagAction = ragOpsForm.action === 'metrics' || ragOpsForm.action === 'ops';

  return (
    <div className="view-stack">
      <SectionHeader title="运营诊断" action={<IconButton title="刷新" onClick={load}><RefreshCw size={18} /></IconButton>} />
      <MockNotice mocked={state.mocked} />
      <ErrorBlock message={state.error} />
      <div className="toolbar">
        <label>
          <span>平台</span>
          <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
            {FILTER_PLATFORM_OPTIONS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}
          </select>
        </label>
      </div>
      <div className="panel">
        <SectionHeader title="登录刷新" />
        <div className="login-refresh-grid">
          {SINGLE_PLATFORM_OPTIONS.map((item) => (
            <button
              className="ops-action"
              type="button"
              disabled={loginRefreshState.loading}
              key={item}
              onClick={() => refreshLogin(item)}
            >
              {loginRefreshState.loading && loginRefreshPlatform === item ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{PLATFORM_LABELS[item]}</span>
            </button>
          ))}
        </div>
        <ErrorBlock message={loginRefreshState.error} />
        {loginRefreshState.data && (
          <div className="notice">
            <CheckCircle2 size={18} />
            <span>
              已创建登录刷新任务：{loginRefreshState.data.taskId} / {STATUS_LABELS[loginRefreshState.data.status]}
            </span>
          </div>
        )}
      </div>
      <div className="panel">
        <SectionHeader title="筛选目录" />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>关键词</th>
                <th>捕获时间</th>
                <th>字段</th>
                <th>选项数</th>
                <th>失败</th>
              </tr>
            </thead>
            <tbody>
              {(state.data?.catalogs ?? []).map((catalog) => (
                <tr key={`${catalog.platform}-${catalog.capturedAt}`}>
                  <td>{PLATFORM_LABELS[catalog.platform]}</td>
                  <td>{catalog.keyword}</td>
                  <td>{formatDate(catalog.capturedAt)}</td>
                  <td>{catalog.stats.discoveredControls}</td>
                  <td>{catalog.stats.optionsExtracted}</td>
                  <td>{catalog.stats.failedControls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="panel ops-rag-panel" onSubmit={submitRagOps}>
        <SectionHeader title="问答运维" />
        <div className="ops-grid">
          {Object.entries(RAG_OPS_ACTION_LABELS).map(([action, label]) => (
            <button
              className={ragOpsForm.action === action ? 'ops-item active' : 'ops-item'}
              type="button"
              key={action}
              onClick={() => setRagOpsField('action', action)}
            >
              <ClipboardList size={20} />
              <strong>{label}</strong>
              <span>{action === 'doctor' ? '检查索引和检索命中' : action === 'review' ? '整理待人工确认回答' : action === 'metrics' ? '汇总问答质量指标' : action === 'ops' ? '生成综合运维判断' : '刷新向量索引'}</span>
            </button>
          ))}
        </div>
        <div className="ops-rag-form">
          {isSingleJobRagAction && (
            <>
              <label>
                <span>平台</span>
                <select value={ragOpsForm.platform} onChange={(event) => setRagOpsField('platform', event.target.value)}>
                  {SINGLE_PLATFORM_OPTIONS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}
                </select>
              </label>
              <label>
                <span>关键词</span>
                <input value={ragOpsForm.keyword} onChange={(event) => setRagOpsField('keyword', event.target.value)} placeholder="可用关键词推导岗位 key" />
              </label>
              <label>
                <span>岗位 key</span>
                <input value={ragOpsForm.jobKey} onChange={(event) => setRagOpsField('jobKey', event.target.value)} placeholder="已有 jobKey 时优先填写" />
              </label>
            </>
          )}
          {isBatchRagAction && (
            <>
              <label>
                <span>岗位列表文件</span>
                <input value={ragOpsForm.file} onChange={(event) => setRagOpsField('file', event.target.value)} placeholder="./rag-review-jobs.json" />
              </label>
              <label>
                <span>策略文件</span>
                <input value={ragOpsForm.policyFile} onChange={(event) => setRagOpsField('policyFile', event.target.value)} placeholder="./rag-metrics-policy.json" />
              </label>
            </>
          )}
          {(ragOpsForm.action === 'doctor' || ragOpsForm.action === 'ops') && (
            <label>
              <span>诊断问题</span>
              <input value={ragOpsForm.question} onChange={(event) => setRagOpsField('question', event.target.value)} placeholder="例如：薪资范围是多少" />
            </label>
          )}
          {(ragOpsForm.action === 'review' || ragOpsForm.action === 'ops') && (
            <>
              <label>
                <span>复核人</span>
                <input value={ragOpsForm.reviewer} onChange={(event) => setRagOpsField('reviewer', event.target.value)} />
              </label>
              <label>
                <span>条数上限</span>
                <input value={ragOpsForm.limit} onChange={(event) => setRagOpsField('limit', event.target.value)} placeholder="例如：20" />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={ragOpsForm.includeReviewed} onChange={(event) => setRagOpsField('includeReviewed', event.target.checked)} />
                <span>包含已复核回答</span>
              </label>
            </>
          )}
          {ragOpsForm.action === 'ops' && (
            <label className="checkbox-row">
              <input type="checkbox" checked={ragOpsForm.failOnIssue} onChange={(event) => setRagOpsField('failOnIssue', event.target.checked)} />
              <span>发现问题时标记任务失败</span>
            </label>
          )}
        </div>
        <div className="run-submit-row">
          <span>{RAG_OPS_ACTION_LABELS[ragOpsForm.action]}会进入任务队列，结果可在任务详情中查看。</span>
          <button className="primary-button" type="submit" disabled={ragOpsState.loading}>
            {ragOpsState.loading ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            执行
          </button>
        </div>
        <ErrorBlock message={ragOpsState.error} />
        {ragOpsState.data && (
          <div className="notice">
            <CheckCircle2 size={18} />
            <span>已创建问答运维任务：{ragOpsState.data.taskId} / {STATUS_LABELS[ragOpsState.data.status]}</span>
          </div>
        )}
      </form>
    </div>
  );
}

function GuideView() {
  return (
    <div className="view-stack guide-view">
      <SectionHeader title="操作说明" />
      <section className="guide-hero">
        <div>
          <span className="guide-kicker">逐步操作手册</span>
          <h2>每个页面怎么点、每一栏填什么</h2>
          <p>按下面顺序操作：先在运营页确认登录和筛选目录，再到执行搜索页提交任务，最后在任务页和岗位页看结果。需要回答候选人问题时使用问答页，需要检查问答质量时使用问答运维。</p>
        </div>
        <div className="guide-flow">
          <span>1. 运营：登录和目录</span>
          <span>2. 执行搜索：填任务</span>
          <span>3. 任务：看日志</span>
          <span>4. 岗位：看候选人</span>
          <span>5. 问答：回答和运维</span>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="一、运营页：开始前必须检查" />
        <div className="guide-grid">
          <article>
            <h3>检查登录状态</h3>
            <ol>
              <li>点击左侧“运营”。</li>
              <li>在顶部“平台”选择“全部平台”，查看所有平台状态。</li>
              <li>查看“登录刷新”下方四个平台按钮：51job、猎聘、智联、Boss直聘。</li>
              <li>如果总览或运营页提示 session 缺失、过期、最近登录刷新失败，点击对应平台按钮。</li>
              <li>按钮点击后会创建“登录刷新”任务，去“任务”页确认状态。</li>
            </ol>
            <div className="guide-field-table">
              <div><strong>平台</strong><span>筛选运营页展示范围。选“全部平台”用于排查全局问题。</span></div>
              <div><strong>登录刷新按钮</strong><span>只刷新对应平台的浏览器登录态，不会抓简历或评分。</span></div>
            </div>
          </article>
          <article>
            <h3>检查筛选目录</h3>
            <ol>
              <li>仍在“运营”页，找到“筛选目录”表格。</li>
              <li>看“平台”是否是你准备执行的平台。</li>
              <li>看“字段”和“选项数”：字段为 0 说明当前没有可用筛选目录。</li>
              <li>看“失败”：大于 0 时，说明部分筛选项采集失败。</li>
              <li>如果目录不可用，先更新筛选目录后再使用可视化筛选构建器。</li>
            </ol>
            <div className="guide-field-table">
              <div><strong>关键词</strong><span>采集筛选目录时使用的搜索关键词，只用于识别目录来源。</span></div>
              <div><strong>捕获时间</strong><span>目录生成时间。平台筛选项变化后，旧目录可能不可用。</span></div>
              <div><strong>字段 / 选项数 / 失败</strong><span>判断可视化筛选是否可靠。失败越多，越应该重新采集。</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="二、执行搜索页：简历抓取怎么填" />
        <div className="guide-grid">
          <article>
            <h3>操作步骤</h3>
            <ol>
              <li>点击左侧“执行搜索”。</li>
              <li>选择顶部模式“简历抓取”。</li>
              <li>在“平台”选择 51job、猎聘、智联、Boss直聘或全部平台。</li>
              <li>填写“关键词”，必须和招聘平台保存搜索或直接搜索目标一致。</li>
              <li>新岗位首次运行时，在“JD 文本”粘贴岗位说明，或在“JD 文件”填本地文件路径，二选一。</li>
              <li>选择“搜索来源”：已保存搜索或直接搜索。</li>
              <li>直接搜索时，可以用下方可视化筛选构建器生成“筛选条件文件”。</li>
              <li>需要邮件通知时填写“收件邮箱”和“抄送邮箱”。</li>
              <li>猎聘需要转发简历时填写“猎聘转发联系人”。</li>
              <li>Boss 需要转发简历时，选择站内同事或邮件转发，再填写对应姓名或邮箱；留言会自动填写候选人 ID。</li>
              <li>确认无误后点击“提交”。</li>
            </ol>
          </article>
          <article>
            <h3>字段怎么填</h3>
            <div className="guide-field-table">
              <div><strong>平台</strong><span>单个平台只跑对应平台；全部平台会按 51job、猎聘、智联顺序执行，前一个失败会停止，不包含 Boss。</span></div>
              <div><strong>关键词</strong><span>必填。用于查找保存搜索、生成 jobKey、复跑已有岗位。</span></div>
              <div><strong>JD 文本</strong><span>新岗位首次运行建议填写。直接粘贴岗位职责、要求、薪资、地点等。</span></div>
              <div><strong>JD 文件</strong><span>本地 JD 文件路径，例如 `./fixtures/jd.txt`。和 JD 文本二选一，不要同时填。</span></div>
              <div><strong>搜索来源</strong><span>已保存搜索：使用平台保存条件；直接搜索：打开搜索页填关键词并应用筛选。</span></div>
              <div><strong>筛选条件文件</strong><span>只在直接搜索时使用。可手填 JSON 路径，也可由可视化筛选构建器自动生成。</span></div>
              <div><strong>收件邮箱</strong><span>可选。填写后任务完成会发送报告。</span></div>
              <div><strong>抄送邮箱</strong><span>可选。多个邮箱用英文逗号分隔。</span></div>
              <div><strong>猎聘转发联系人</strong><span>只对猎聘普通抓取有效。填写招聘平台里可搜索到的联系人名。</span></div>
              <div><strong>Boss 转发方式</strong><span>只对 Boss 单平台普通抓取有效。可选择站内同事或邮件转发；不选择则不转发。</span></div>
              <div><strong>Boss 转发收件人</strong><span>站内同事模式填写姓名并匹配唯一同事；邮件模式填写收件人邮箱。留言自动使用候选人 ID。</span></div>
              <div><strong>包含已查看候选人</strong><span>默认不勾选。勾选后会把平台里已查看的候选人也纳入本次搜索。</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="三、执行搜索页：批量任务怎么填" />
        <div className="guide-grid">
          <article>
            <h3>操作步骤</h3>
            <ol>
              <li>点击“执行搜索”。</li>
              <li>选择顶部模式“批量任务”。</li>
              <li>选择“平台”。如果选择全部平台，外层按 jobs 文件顺序，内层按 51job、猎聘、智联顺序执行，不包含 Boss。</li>
              <li>填写“批量任务文件”，这是必填项。</li>
              <li>选择“搜索来源”。批量也可以选择直接搜索。</li>
              <li>直接搜索时，可填写通用“筛选条件文件”；如果 jobs 文件内某个岗位也设置了筛选文件，以岗位级设置为准。</li>
              <li>填写邮件、抄送、猎聘联系人或 Boss 转发配置等可选项。</li>
              <li>点击“提交”。</li>
            </ol>
          </article>
          <article>
            <h3>字段怎么填</h3>
            <div className="guide-field-table">
              <div><strong>平台</strong><span>控制批量任务要跑哪些平台。全部平台会严格按固定平台顺序运行。</span></div>
              <div><strong>批量任务文件</strong><span>必填。本地 jobs JSON 路径，例如 `./jobs.json`。</span></div>
              <div><strong>搜索来源</strong><span>saved 使用保存搜索；direct 逐个岗位直接搜索。</span></div>
              <div><strong>筛选条件文件</strong><span>可选，仅 direct 有效。作为批量任务默认筛选，岗位内配置可覆盖它。</span></div>
              <div><strong>包含已查看候选人</strong><span>默认不勾选。批量场景谨慎使用，可能扩大候选人范围。</span></div>
              <div><strong>邮件字段</strong><span>作为批量默认收件配置；岗位记录中已有收件配置时会按任务规则处理。</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="四、执行搜索页：搜索订阅怎么填" />
        <div className="guide-grid">
          <article>
            <h3>操作步骤</h3>
            <ol>
              <li>点击“执行搜索”。</li>
              <li>选择顶部模式“搜索订阅”。</li>
              <li>选择平台。需要筛选构建器时，选择单个平台，不要选全部平台。</li>
              <li>填写“关键词”。如果订阅文件已有关键词，可不填；需要覆盖或指定时再填。</li>
              <li>填写“订阅文件”，这是必填项。</li>
              <li>需要保存平台订阅时，填写“订阅名称”并勾选“保存搜索订阅”。</li>
              <li>需要筛选时，在下方筛选构建器生成文件，或手填“筛选条件文件”。</li>
              <li>点击“提交”。</li>
            </ol>
          </article>
          <article>
            <h3>字段怎么填</h3>
            <div className="guide-field-table">
              <div><strong>平台</strong><span>搜索订阅可跑单个平台或全部平台；带可视化筛选时建议单个平台。</span></div>
              <div><strong>关键词</strong><span>可选。用于指定本次订阅搜索关键词。</span></div>
              <div><strong>订阅文件</strong><span>必填。本地搜索订阅 JSON 路径，例如 `./search-subscription.json`。</span></div>
              <div><strong>订阅名称</strong><span>可选。勾选保存搜索订阅时，用作平台保存订阅名称。</span></div>
              <div><strong>筛选条件文件</strong><span>可选。提交时后端会写入临时订阅文件，不会直接传普通抓取参数。</span></div>
              <div><strong>保存搜索订阅</strong><span>勾选后会尝试把当前搜索订阅保存到招聘平台。</span></div>
            </div>
            <p className="guide-note">搜索订阅只处理订阅，不解析 JD、不抓简历、不评分、不发邮件。</p>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="五、可视化筛选构建器怎么用" />
        <div className="guide-grid">
          <article>
            <h3>使用步骤</h3>
            <ol>
              <li>在“执行搜索”页先选择单个平台。</li>
              <li>简历抓取模式下，把“搜索来源”改为“直接搜索”；或直接切到“搜索订阅”。</li>
              <li>页面下方出现“平台筛选”。如果显示“筛选构建器需要先选择单个平台”，把平台从“全部平台”改成具体平台。</li>
              <li>点击右上角刷新图标，可重新读取筛选目录。</li>
              <li>单选字段：点击快捷按钮，或在“更多”下拉里选择。</li>
              <li>城市、行业、职位等字段：先在搜索框输入关键词，再在“选项”下拉选择路径。</li>
              <li>年龄、薪资等范围字段：分别选择最小值和最大值。</li>
              <li>上方“已选”区域会显示当前筛选，点击某个已选项可清除。</li>
              <li>确认 JSON 预览正确后，点击“生成 Filter File”。</li>
              <li>生成成功后，页面会自动把文件路径填到“筛选条件文件”。</li>
            </ol>
          </article>
          <article>
            <h3>每类控件怎么填</h3>
            <div className="guide-field-table">
              <div><strong>快捷按钮</strong><span>适合学历、经验、性别等常用单选。选错后点“不限”或右侧清除按钮。</span></div>
              <div><strong>更多下拉</strong><span>快捷按钮没展示完整选项时使用。</span></div>
              <div><strong>搜索输入</strong><span>用于城市、行业、职位、学校等选项很多的字段。</span></div>
              <div><strong>路径选项</strong><span>看到“父级 / 子级”时优先选完整路径，避免重复名称选错。</span></div>
              <div><strong>范围下拉</strong><span>年龄、薪资等字段可以只填最小值、只填最大值，或两边都填。</span></div>
              <div><strong>JSON 预览</strong><span>最终会保存的筛选输入。为空时不能生成文件。</span></div>
              <div><strong>生成 Filter File</strong><span>保存筛选 JSON，并自动回填到任务表单。</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="六、任务页：提交后怎么看是否成功" />
        <div className="guide-grid three">
          <article>
            <h3>任务列表</h3>
            <ol>
              <li>点击左侧“任务”。</li>
              <li>左侧列表默认按更新时间倒序显示。</li>
              <li>点击刚提交的任务行。</li>
              <li>右侧查看任务详情。</li>
            </ol>
          </article>
          <article>
            <h3>详情字段</h3>
            <div className="guide-field-table">
              <div><strong>任务 ID</strong><span>唯一编号。排查问题时复制给开发或运维。</span></div>
              <div><strong>状态</strong><span>排队中、运行中、成功、失败。失败时先看错误和日志。</span></div>
              <div><strong>输入摘要</strong><span>确认平台、关键词、文件路径、筛选文件是否填对。</span></div>
              <div><strong>输出摘要</strong><span>成功后显示候选人数、结果路径、问答运维摘要等。</span></div>
              <div><strong>运行日志</strong><span>失败排查最重要。看最后几条错误，再回到对应页面修正输入。</span></div>
            </div>
          </article>
          <article>
            <h3>常见状态</h3>
            <ul>
              <li>排队中：前面还有任务，等待即可。</li>
              <li>运行中：浏览器或后台正在执行，不要重复提交同一个任务。</li>
              <li>成功：进入岗位页看结果。</li>
              <li>失败：根据运行日志修正登录、文件路径、筛选条件或 JD 输入。</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="七、岗位页和候选人详情怎么看" />
        <div className="guide-grid">
          <article>
            <h3>岗位页</h3>
            <ol>
              <li>点击左侧“岗位”。</li>
              <li>在“平台”选择全部平台或单个平台。</li>
              <li>在搜索框输入岗位关键词、jobKey、城市或标题过滤历史岗位。</li>
              <li>点击岗位行右侧入口进入岗位详情。</li>
              <li>查看候选人数、评分数、最近运行、导出路径。</li>
              <li>在候选人列表点击候选人进入详情。</li>
            </ol>
          </article>
          <article>
            <h3>候选人详情</h3>
            <div className="guide-field-table">
              <div><strong>基础信息</strong><span>姓名、年龄、学历、地区、当前公司、当前职位。</span></div>
              <div><strong>评分</strong><span>查看总分、摘要和失败原因。评分失败不会撤销已抓取简历。</span></div>
              <div><strong>简历 JSON</strong><span>解析后的结构化简历，用于确认工作经历、教育经历是否正确。</span></div>
              <div><strong>快照预览</strong><span>原始页面文本片段。解析有争议时用它对照。</span></div>
              <div><strong>分享链接</strong><span>智联邮件发送依赖当前 run 复制到的同事转发链接。</span></div>
            </div>
          </article>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="八、问答页：候选人问题怎么回答" />
        <div className="guide-grid">
          <article>
            <h3>已存岗位模式</h3>
            <ol>
              <li>点击左侧“问答”。</li>
              <li>选择“已存岗位”。</li>
              <li>选择平台。</li>
              <li>填写“岗位 Key”或“关键词”。已有 jobKey 时优先填岗位 Key。</li>
              <li>“召回数量”通常保持默认 5，需要更多来源时再调大。</li>
              <li>在“问题”填写候选人的原始问题。</li>
              <li>保持“自动建索引”勾选，可在缺索引时自动建立。</li>
              <li>保持“记录回答”勾选，可用于后续问答运维复核。</li>
              <li>点击“提问”。</li>
            </ol>
          </article>
          <article>
            <h3>临时职位说明模式</h3>
            <ol>
              <li>选择“临时职位说明”。</li>
              <li>选择平台。这里只用于标识来源，不会创建岗位记录。</li>
              <li>可选填写岗位 Key 或关键词，便于结果识别。</li>
              <li>在“JD 文本”粘贴本次临时 JD，或在“JD 文件”填路径，二选一。</li>
              <li>填写问题。</li>
              <li>点击“提问”。</li>
            </ol>
            <p className="guide-note">临时 JD 不会写入生产 RAG 索引，也不会追加生产 answer logs。</p>
          </article>
        </div>
        <div className="guide-field-table guide-wide-table">
          <div><strong>平台</strong><span>必填。已存岗位模式用于定位平台下的岗位数据。</span></div>
          <div><strong>岗位 Key</strong><span>可选但推荐。比关键词更精确，避免同名岗位混淆。</span></div>
          <div><strong>关键词</strong><span>没有岗位 Key 时填写，系统会按关键词推导 jobKey。</span></div>
          <div><strong>召回数量</strong><span>已存岗位模式使用。控制检索多少条来源片段。</span></div>
          <div><strong>JD 文本 / JD 文件</strong><span>只在临时职位说明模式使用，二选一。</span></div>
          <div><strong>问题</strong><span>必填。尽量使用候选人的原话，例如“这个岗位双休吗”。</span></div>
          <div><strong>自动建索引</strong><span>已存岗位模式使用。缺少索引时自动根据已保存 JD 建索引。</span></div>
          <div><strong>记录回答</strong><span>已存岗位模式使用。勾选后回答会进入后续人工复核和指标统计。</span></div>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="九、运营页：问答运维每个动作怎么填" />
        <div className="guide-grid">
          <article>
            <h3>单岗位动作</h3>
            <ol>
              <li>进入“运营”。</li>
              <li>在“问答运维”选择“索引检查”“人工复核”或“重建索引”。</li>
              <li>选择平台。</li>
              <li>填写“岗位 key”或“关键词”。已有 jobKey 时优先填岗位 key。</li>
              <li>索引检查可填写“诊断问题”，用于检查某个候选人问题能否检索到事实。</li>
              <li>人工复核可填写“复核人”和“条数上限”。</li>
              <li>点击“执行”。</li>
              <li>去“任务”页查看问答运维任务输出摘要。</li>
            </ol>
          </article>
          <article>
            <h3>批量动作</h3>
            <ol>
              <li>选择“指标汇总”或“运维策略”。</li>
              <li>填写“岗位列表文件”，例如 `./rag-review-jobs.json`。</li>
              <li>如果有质量阈值文件，填写“策略文件”。</li>
              <li>运维策略可填写“诊断问题”，用于批量检查某类问题。</li>
              <li>需要复核人标识时填写“复核人”。</li>
              <li>需要限制输出数量时填写“条数上限”。</li>
              <li>如果希望发现问题时任务直接失败，勾选“发现问题时标记任务失败”。</li>
              <li>点击“执行”。</li>
            </ol>
          </article>
        </div>
        <div className="guide-field-table guide-wide-table">
          <div><strong>索引检查</strong><span>检查单个岗位 RAG 索引、manifest、chunk、Qdrant 和检索命中。</span></div>
          <div><strong>人工复核</strong><span>整理单个岗位低置信度、无答案、缺少来源或未复核回答。</span></div>
          <div><strong>指标汇总</strong><span>读取岗位列表文件，统计总回答数、复核率、正确率、无答案率等。</span></div>
          <div><strong>运维策略</strong><span>组合索引检查、人工复核、指标汇总，给出整体状态和建议。</span></div>
          <div><strong>重建索引</strong><span>当索引失配、embedding 配置变化、向量库缺数据时使用。</span></div>
          <div><strong>岗位列表文件</strong><span>JSON 或 JSONL，包含 platform 和 jobKey 的列表，供批量指标和策略使用。</span></div>
          <div><strong>策略文件</strong><span>可选。定义复核率、正确率、无答案率等质量阈值。</span></div>
          <div><strong>条数上限</strong><span>限制复核或运维输出的条目数量，避免结果过长。</span></div>
        </div>
      </section>

      <section className="guide-section">
        <SectionHeader title="十、常见问题" />
        <div className="guide-faq">
          <article>
            <h3>页面提交后没有变化怎么办？</h3>
            <p>先打开“任务”页点击刷新，确认是否创建任务。如果没有任务，回到原页面看错误提示。API 刚改过代码时需要重启后端；前端开发服务通常刷新浏览器即可。</p>
          </article>
          <article>
            <h3>不知道 jobKey 怎么办？</h3>
            <p>先在“岗位”页按平台和关键词搜索历史岗位。没有 jobKey 时，在问答或问答运维里填关键词，系统会按关键词推导。</p>
          </article>
          <article>
            <h3>筛选文件生成了但任务没用上怎么办？</h3>
            <p>简历抓取必须选择“直接搜索”才会使用筛选条件文件。搜索订阅会把筛选文件写进临时订阅文件后执行。</p>
          </article>
          <article>
            <h3>候选人数异常怎么排查？</h3>
            <p>先看“总览”的零候选 run、处理失败、最近失败，再进入“任务”页看日志，判断是登录、筛选、平台空结果还是解析失败。</p>
          </article>
          <article>
            <h3>为什么搜索订阅不能填 JD？</h3>
            <p>搜索订阅是独立模式，只处理搜索订阅，不抓简历、不评分、不导出报告，因此不会解析 JD。</p>
          </article>
          <article>
            <h3>什么时候需要重建 RAG 索引？</h3>
            <p>当问答运维提示 manifest 数量不一致、embedding 模型变化、Qdrant 无命中但本地事实存在时，运行“重建索引”。</p>
          </article>
          <article>
            <h3>任务失败后是否会丢数据？</h3>
            <p>成功抓取的简历会保留；评分失败会保存失败评分工件；未成功打开或转发的候选人通常保持可重试。</p>
          </article>
        </div>
      </section>
    </div>
  );
}
