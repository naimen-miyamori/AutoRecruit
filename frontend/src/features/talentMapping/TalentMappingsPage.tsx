import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, CheckCircle2, ListTree, Map, Play, RefreshCw, Search, ShieldAlert, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  MappingCandidateView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingRunRecord,
  TalentMappingCorePlatform,
  TalentMappingProjectDetail,
  TalentMappingProjectSummary,
} from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { SafetyDialog } from '../../components/SafetyDialog';
import {
  EmptyState,
  ErrorState,
  IconButton,
  JsonViewer,
  LoadingState,
  Metric,
  PageHeader,
  PLATFORM_LABELS,
  Section,
  StatusPill,
  SuccessNotice,
  formatCompactDate,
  formatDate,
} from '../../components/ui';

type MappingTab = 'overview' | 'companies' | 'candidates' | 'runs' | 'settings';

const MAPPING_TABS: Array<[MappingTab, string]> = [
  ['overview', '概览'],
  ['companies', '公司矩阵'],
  ['candidates', '人才清单'],
  ['runs', '运行记录'],
  ['settings', '项目设置'],
];

export function TalentMappingsPage() {
  const { mappingKey } = useParams();
  const listQuery = useQuery({
    queryKey: queryKeys.talentMappings,
    queryFn: ({ signal }) => api.listTalentMappings(signal),
  });

  return (
    <div className="page-stack mapping-workbench">
      <PageHeader
        eyebrow="TALENT LANDSCAPE"
        title="人才地图"
        description="多搜索切片、平台内稳定身份和可追溯证据。卡片级结果仅表示市场扫描；跨平台候选人不会自动合并。"
        actions={<><Link className="primary-button" to="/run?mode=talent-mapping"><Play size={16} />新建 Mapping</Link><IconButton label="刷新项目" onClick={() => void listQuery.refetch()}><RefreshCw size={17} /></IconButton></>}
      />
      <div className="mapping-policy-banner"><ShieldAlert size={20} /><div><strong>身份与副作用边界</strong><span>唯一人数按 platform:candidateId 统计；详情补全可能改变平台“已查看”状态，每轮必须重新确认。</span></div></div>
      {listQuery.error && <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />}
      {listQuery.isLoading && <Section><LoadingState label="读取本地人才地图项目" /></Section>}
      {!listQuery.isLoading && !mappingKey && <MappingProjectList mappings={listQuery.data?.mappings ?? []} />}
      {mappingKey && <MappingProject key={mappingKey} mappingKey={mappingKey} />}
    </div>
  );
}

function MappingProjectList({ mappings }: { mappings: TalentMappingProjectSummary[] }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => mappings.filter((mapping) => {
    const haystack = [mapping.mappingKey, mapping.name, ...mapping.objective.roleFamilies, ...mapping.objective.locations].join(' ').toLowerCase();
    return !search.trim() || haystack.includes(search.trim().toLowerCase());
  }), [mappings, search]);

  return (
    <>
      <Section>
        <div className="toolbar"><label><span>搜索项目</span><div className="search-input"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称、mappingKey、岗位族、地域" /></div></label><strong>{filtered.length} 个项目</strong></div>
      </Section>
      {filtered.length === 0
        ? <Section><EmptyState title="没有人才地图项目" description="从“新建 Mapping”提交版本化 JSON 计划，扫描完成后会在这里出现。" /></Section>
        : <div className="mapping-project-list">{filtered.map((mapping) => <MappingProjectRow key={mapping.mappingKey} mapping={mapping} />)}</div>}
    </>
  );
}

function MappingProjectRow({ mapping }: { mapping: TalentMappingProjectSummary }) {
  const label = mapping.enrichmentMode === 'card-only' ? '市场扫描 / Mapping 初筛' : mapping.enrichmentMode;
  return (
    <Link className="mapping-project-row" to={`/talent-mappings/${encodeURIComponent(mapping.mappingKey)}`}>
      <div className="mapping-project-identity"><span className="eyebrow">{label}</span><h3>{mapping.name}</h3><p className="mono">{mapping.mappingKey}</p><small>{mapping.objective.roleFamilies.join('、') || '未设置岗位族'} · {mapping.objective.locations.join('、') || '未设置地域'}</small></div>
      <div className="job-stat"><span>搜索切片</span><strong>{mapping.sliceCount}</strong></div>
      <div className="job-stat"><span>平台档案</span><strong>{mapping.candidateCount}</strong></div>
      <div className="job-stat"><span>详情已补全</span><strong>{mapping.enrichedCandidateCount}</strong></div>
      <div className="job-stat"><span>最近运行</span><strong>{formatCompactDate(mapping.latestRun?.finishedAt)}</strong><small>{mapping.latestRun?.status ?? '尚未运行'}</small></div>
    </Link>
  );
}

function MappingProject({ mappingKey }: { mappingKey: string }) {
  const [tab, setTab] = useState<MappingTab>('overview');
  const detailQuery = useQuery({
    queryKey: queryKeys.talentMapping(mappingKey),
    queryFn: ({ signal }) => api.getTalentMapping(mappingKey, signal),
  });
  const runsQuery = useQuery({
    queryKey: queryKeys.talentMappingRuns(mappingKey),
    queryFn: ({ signal }) => api.listTalentMappingRuns(mappingKey, signal),
  });
  const candidatesQuery = useQuery({
    queryKey: queryKeys.talentMappingCandidates(mappingKey),
    queryFn: ({ signal }) => api.listTalentMappingCandidates(mappingKey, signal),
  });
  const companiesQuery = useQuery({
    queryKey: queryKeys.talentMappingCompanies(mappingKey),
    queryFn: ({ signal }) => api.listTalentMappingCompanies(mappingKey, signal),
  });
  const coverageQuery = useQuery({
    queryKey: queryKeys.talentMappingCoverage(mappingKey),
    queryFn: ({ signal }) => api.getTalentMappingCoverage(mappingKey, signal),
  });
  const taskMutation = useMutation({ mutationFn: (body: Record<string, unknown>) => api.submitTalentMapping(body) });
  const detail = detailQuery.data;
  const platformSelection = detail?.detailSelection.platformSelection
    ?? detail?.summary.latestRun?.platformSelection
    ?? (detail?.summary.platforms.length === 1 ? detail.summary.platforms[0] : 'all');
  const refreshAll = async () => {
    await Promise.all([
      detailQuery.refetch(), runsQuery.refetch(), candidatesQuery.refetch(), companiesQuery.refetch(), coverageQuery.refetch(),
    ]);
  };
  const submitScan = () => {
    if (!detail) return;
    taskMutation.mutate({
      platform: platformSelection,
      talentMappingFile: detail.project.sourceFilePath,
      mappingStage: 'scan',
    });
  };
  const submitEnrich = () => {
    if (!detail?.detailSelection.available) return;
    taskMutation.mutate({
      platform: detail.detailSelection.platformSelection,
      talentMappingFile: detail.project.sourceFilePath,
      mappingStage: 'enrich',
      mappingRunId: detail.detailSelection.sourceScanRunId,
      confirmedDetailOpen: true,
    });
  };

  if (detailQuery.isLoading) return <Section><LoadingState label="读取人才地图项目" /></Section>;
  if (detailQuery.error) return <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />;
  if (!detail) return <Section><EmptyState title="项目不存在" /></Section>;

  const detailSelection = detail.detailSelection;
  const platformBreakdown = Object.entries(detailSelection.candidatesByPlatform)
    .map(([platform, count]) => `${PLATFORM_LABELS[platform as TalentMappingCorePlatform]} ${count}`)
    .join('、') || '-';

  return (
    <>
      <Section className="mapping-project-heading">
        <div className="mapping-heading-row">
          <div><Link className="text-link" to="/talent-mappings">← 返回项目列表</Link><h2>{detail.project.name}</h2><p className="mono">{detail.project.mappingKey}</p></div>
          <div className="page-actions">
            <button className="secondary-button" type="button" disabled={taskMutation.isPending} onClick={submitScan}><RefreshCw size={15} />重新扫描</button>
            <SafetyDialog
              trigger={<button className="primary-button" type="button" disabled={!detailSelection.available || taskMutation.isPending}><UsersRound size={16} />详情补全（{detailSelection.candidateCount}）</button>}
              title="确认本轮详情补全"
              description={`本轮将按计划的确定性规则打开 ${detailSelection.candidateCount} 位候选人详情；该操作可能改变平台“已查看”状态。`}
              tone="warning"
              facts={[
                { label: 'Mapping 项目', value: detail.project.name },
                { label: '精确详情数量', value: `${detailSelection.candidateCount} 位` },
                { label: '平台分布', value: platformBreakdown },
                { label: '来源扫描 Run ID', value: <span className="mono">{detailSelection.sourceScanRunId ?? '-'}</span> },
              ]}
              confirmLabel="确认打开详情"
              busy={taskMutation.isPending}
              onConfirm={submitEnrich}
            />
            <IconButton label="刷新项目数据" onClick={() => void refreshAll()}><RefreshCw size={17} /></IconButton>
          </div>
        </div>
        {!detailSelection.available && <p className="inline-note">详情补全当前不可用：{detailSelection.blockedReason ?? '没有可补全候选人'}</p>}
      </Section>
      {taskMutation.error && <ErrorState error={taskMutation.error} />}
      {taskMutation.data && <SuccessNotice><CheckCircle2 size={18} />任务已进入共享串行队列：<Link className="text-link" to={`/tasks/${encodeURIComponent(taskMutation.data.taskId)}`}>{taskMutation.data.taskId}</Link></SuccessNotice>}
      <Section><div className="tabs">{MAPPING_TABS.map(([value, label]) => <button type="button" className={tab === value ? 'active' : ''} key={value} onClick={() => setTab(value)}>{label}</button>)}</div></Section>
      {queryError(runsQuery.error, candidatesQuery.error, companiesQuery.error, coverageQuery.error)}
      {tab === 'overview' && <MappingOverview detail={detail} coverage={coverageQuery.data?.coverage ?? []} loading={coverageQuery.isLoading} />}
      {tab === 'companies' && <CompanyMatrix rows={companiesQuery.data?.companies ?? []} loading={companiesQuery.isLoading} />}
      {tab === 'candidates' && <CandidateList candidates={candidatesQuery.data?.candidates ?? []} loading={candidatesQuery.isLoading} />}
      {tab === 'runs' && <MappingRuns runs={runsQuery.data?.runs ?? []} loading={runsQuery.isLoading} />}
      {tab === 'settings' && <MappingSettings detail={detail} />}
    </>
  );
}

function queryError(...errors: unknown[]) {
  const error = errors.find(Boolean);
  return error ? <ErrorState error={error} /> : null;
}

function MappingOverview({ detail, coverage, loading }: { detail: TalentMappingProjectDetail; coverage: MappingCoverageViewRow[]; loading: boolean }) {
  const summary = detail.summary;
  const gaps = coverage.filter((row) => row.coverageStatus !== 'complete' || row.failedProfiles.length > 0);
  const detailRate = summary.candidateCount > 0 ? summary.enrichedCandidateCount / summary.candidateCount : 0;
  return (
    <div className="page-stack">
      <div className="metric-grid">
        <Metric label="平台唯一档案" value={summary.candidateCount} note="跨平台未自动合并" icon={<UsersRound size={16} />} />
        <Metric label="详情已补全" value={summary.enrichedCandidateCount} note={formatPercent(detailRate)} tone="success" icon={<CheckCircle2 size={16} />} />
        <Metric label="待归类档案" value={summary.unclassifiedCandidateCount} tone={summary.unclassifiedCandidateCount ? 'warning' : 'success'} icon={<ListTree size={16} />} />
        <Metric label="公司矩阵单元" value={summary.companyMatrixRowCount} icon={<Building2 size={16} />} />
        <Metric label="搜索切片" value={summary.sliceCount} icon={<Map size={16} />} />
        <Metric label="覆盖缺口" value={gaps.length} tone={gaps.length ? 'warning' : 'success'} icon={<ShieldAlert size={16} />} />
      </div>
      <Section title="平台 / 切片进度" description="complete 仅表示到达明确终点；capped 和 failed 不会被包装成全量覆盖。">
        {loading ? <LoadingState /> : <CoverageTable coverage={coverage} />}
      </Section>
      <Section title="详情覆盖与 gaps" description="详情失败保留卡片观察，后续可在新运行中重试。">
        {gaps.length === 0
          ? <EmptyState title="当前派生视图没有覆盖缺口" />
          : <div className="compact-list">{gaps.map((row) => <div className="compact-item" key={`${row.sliceId}-${row.platform}`}><StatusPill status={row.coverageStatus === 'failed' ? 'failed' : 'warning'} label={row.coverageStatus} /><div><strong>{row.sliceId} · {PLATFORM_LABELS[row.platform]}</strong><small>{row.terminationReason} · 详情 {row.enrichedProfiles}/{row.eligibleForDetail} · 失败 {row.failedProfiles.length}</small></div></div>)}</div>}
      </Section>
    </div>
  );
}

function CoverageTable({ coverage }: { coverage: MappingCoverageViewRow[] }) {
  if (coverage.length === 0) return <EmptyState title="暂无覆盖数据" description="完成一次扫描后生成覆盖派生视图。" />;
  return <div className="table-wrap"><table><thead><tr><th>切片 / 平台</th><th>结果总数</th><th>批次</th><th>卡片 / 唯一档案</th><th>卡片覆盖</th><th>详情覆盖</th><th>终止原因</th><th>状态</th></tr></thead><tbody>{coverage.map((row) => <tr key={`${row.sliceId}-${row.platform}`}><td><div className="cell-main"><strong>{row.sliceId}</strong><small>{PLATFORM_LABELS[row.platform]}</small></div></td><td>{row.reportedResultTotal ?? '未知'}<small>{row.reportedResultTotalSource ?? ''}</small></td><td>{row.scannedBatches}</td><td>{row.observedCards} / {row.uniquePlatformProfiles}</td><td>{row.cardCoverageStatus === 'known' ? formatPercent(row.cardCoverage) : 'unknown'}</td><td>{row.detailCoverageStatus === 'known' ? formatPercent(row.detailCoverage) : '无合格详情'}</td><td>{row.terminationReason}</td><td><StatusPill status={row.coverageStatus === 'failed' ? 'failed' : row.coverageStatus === 'capped' ? 'warning' : 'succeeded'} label={row.coverageStatus} /></td></tr>)}</tbody></table></div>;
}

function CompanyMatrix({ rows, loading }: { rows: MappingCompanyRoleMatrixRow[]; loading: boolean }) {
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<'all' | TalentMappingCorePlatform>('all');
  const filtered = useMemo(() => rows.filter((row) => {
    const matchesPlatform = platform === 'all' || row.platform === platform;
    const haystack = [row.companyKey, row.companyDisplayName, row.companyTier, row.roleKey, row.roleDisplayName, row.level, row.location].filter(Boolean).join(' ').toLowerCase();
    return matchesPlatform && (!search.trim() || haystack.includes(search.trim().toLowerCase()));
  }), [platform, rows, search]);
  return <Section title="公司 × 岗位族 × 职级 × 地域" description="每行按平台身份独立计数；待归类不会由模型猜测。" actions={<div className="filter-row"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as typeof platform)}><option value="all">全部主平台</option><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option></select></label><label><span>筛选矩阵</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="公司、岗位、职级、地域" /></label></div>}>{loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState title="没有匹配的矩阵单元" /> : <div className="table-wrap"><table><thead><tr><th>公司</th><th>层级</th><th>岗位族</th><th>职级</th><th>地域</th><th>平台</th><th>平台档案</th><th>详情</th><th>待归类</th></tr></thead><tbody>{filtered.map((row) => <tr key={matrixKey(row)}><td><div className="cell-main"><strong>{row.companyDisplayName}</strong><small className="mono">{row.companyKey}</small></div></td><td>{row.companyTier ?? '-'}</td><td><div className="cell-main"><strong>{row.roleDisplayName}</strong><small className="mono">{row.roleKey}</small></div></td><td>{row.level}</td><td>{row.location}</td><td><span className={`platform-mark platform-${row.platform}`}>{PLATFORM_LABELS[row.platform]}</span></td><td>{row.platformProfiles}</td><td>{row.enrichedProfiles}</td><td>{row.unclassifiedProfiles}</td></tr>)}</tbody></table></div>}</Section>;
}

function CandidateList({ candidates, loading }: { candidates: MappingCandidateView[]; loading: boolean }) {
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<'all' | TalentMappingCorePlatform>('all');
  const [detailStatus, setDetailStatus] = useState<'all' | MappingCandidateView['detailStatus']>('all');
  const filtered = useMemo(() => candidates.filter((candidate) => {
    const matchesPlatform = platform === 'all' || candidate.platform === platform;
    const matchesDetail = detailStatus === 'all' || candidate.detailStatus === detailStatus;
    const haystack = [candidate.platformCandidateKey, candidate.name, candidate.currentCompany, candidate.currentTitle, candidate.companyKey, candidate.roleKey, candidate.level, candidate.location, ...candidate.sourceSliceIds].filter(Boolean).join(' ').toLowerCase();
    return matchesPlatform && matchesDetail && (!search.trim() || haystack.includes(search.trim().toLowerCase()));
  }), [candidates, detailStatus, platform, search]);
  return <Section title="人才清单" description="平台 identity 是唯一执行身份；姓名、公司、职位相似不会触发跨平台合并。" actions={<div className="filter-row"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as typeof platform)}><option value="all">全部主平台</option><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option></select></label><label><span>详情状态</span><select value={detailStatus} onChange={(event) => setDetailStatus(event.target.value as typeof detailStatus)}><option value="all">全部</option><option value="not-enriched">未补全</option><option value="enriched">已补全</option></select></label><label><span>搜索人才</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="身份、公司、岗位、切片" /></label></div>}>{loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState title="没有匹配的人才档案" /> : <div className="table-wrap"><table><thead><tr><th>平台身份</th><th>当前公司 / 岗位</th><th>岗位族 / 职级</th><th>地域</th><th>来源切片</th><th>首次 / 最近观察</th><th>详情</th></tr></thead><tbody>{filtered.map((candidate) => <tr key={candidate.platformCandidateKey}><td><div className="cell-main"><span className={`platform-mark platform-${candidate.platform}`}>{PLATFORM_LABELS[candidate.platform]}</span><strong>{candidate.name ?? '未命名候选人'}</strong><small className="mono">{candidate.platformCandidateKey}</small></div></td><td><div className="cell-main"><strong>{candidate.currentCompany ?? '待归类'}</strong><small>{candidate.currentTitle ?? '待归类'}</small></div></td><td>{candidate.roleKey ?? '待归类'}<small>{candidate.level ?? '待归类'}</small></td><td>{candidate.location ?? '待归类'}</td><td>{candidate.sourceSliceIds.join('、')}</td><td>{formatCompactDate(candidate.firstObservedAt)}<small>{formatCompactDate(candidate.lastObservedAt)}</small></td><td><StatusPill status={candidate.detailStatus === 'enriched' ? 'succeeded' : 'neutral'} label={candidate.detailStatus === 'enriched' ? '已补全' : '未补全'} /></td></tr>)}</tbody></table></div>}</Section>;
}

function MappingRuns({ runs, loading }: { runs: MappingRunRecord[]; loading: boolean }) {
  const rows = runs.flatMap((run) => run.sliceRuns.map((sliceRun) => ({ run, sliceRun })));
  return <Section title="运行记录" description="失败运行保留已写 observation 和 checkpoint；completed-with-gaps 仍会显式显示 capped 或详情缺口。">{loading ? <LoadingState /> : rows.length === 0 ? <EmptyState title="暂无运行记录" /> : <div className="table-wrap"><table><thead><tr><th>运行 / 阶段</th><th>切片 / 平台</th><th>卡片 / 唯一档案</th><th>详情</th><th>失败详情</th><th>终止原因</th><th>状态</th><th>完成时间</th></tr></thead><tbody>{rows.map(({ run, sliceRun }) => <tr key={`${run.runId}-${sliceRun.sliceId}-${sliceRun.platform}`}><td><div className="cell-main"><strong>{run.stage}</strong><small className="mono">{run.runId}</small></div></td><td><div className="cell-main"><strong>{sliceRun.sliceId}</strong><small>{PLATFORM_LABELS[sliceRun.platform]}</small></div></td><td>{sliceRun.observedCards} / {sliceRun.uniquePlatformProfiles}<small>{sliceRun.scannedBatches} 批次</small></td><td>{sliceRun.enrichedProfiles}/{sliceRun.eligibleForDetail}</td><td>{sliceRun.failedProfiles.length}{sliceRun.error && <small>{sliceRun.error}</small>}</td><td>{sliceRun.terminationReason}</td><td><StatusPill status={sliceRun.status === 'failed' ? 'failed' : sliceRun.status === 'completed-with-gaps' ? 'warning' : 'succeeded'} label={sliceRun.status} /></td><td>{formatDate(sliceRun.finishedAt)}</td></tr>)}</tbody></table></div>}</Section>;
}

function MappingSettings({ detail }: { detail: TalentMappingProjectDetail }) {
  const project = detail.project;
  return <div className="two-column"><Section title="权威计划" description="首版只读；版本化 JSON 文件仍是执行输入。"><div className="detail-grid"><div className="detail-cell"><span>版本</span><strong>v{project.version}</strong></div><div className="detail-cell"><span>完整性</span><strong>{project.enrichment.mode === 'card-only' ? '市场扫描 / Mapping 初筛' : project.enrichment.mode}</strong></div><div className="detail-cell"><span>批次上限</span><strong>{project.coverage.maxBatchesPerSlice}/切片</strong></div><div className="detail-cell"><span>候选上限</span><strong>{project.coverage.maxCandidatesPerSlice}/切片</strong></div></div><div className="detail-cell settings-source"><span>计划文件</span><strong className="mono">{project.sourceFilePath}</strong></div><JsonViewer value={{ objective: project.objective, taxonomy: project.taxonomy, coverage: project.coverage, enrichment: project.enrichment }} /></Section><Section title="搜索切片" description="相对 searchPlanFile 已在服务端按 Mapping 文件目录解析。"><div className="compact-list">{project.slices.map((slice) => <div className="compact-item mapping-slice-setting" key={slice.sliceId}><div><strong>{slice.label}</strong><small className="mono">{slice.sliceId}</small><small>{(['51job', 'liepin', 'zhilian'] as const).map((platform) => { const plan = slice.platformPlans[platform]; return `${PLATFORM_LABELS[platform]}: ${!plan ? '未配置' : plan.disabled ? `禁用（${plan.reason}）` : `${plan.searchSource} · ${plan.searchPlanFile}`}`; }).join('\n')}</small></div></div>)}</div></Section></div>;
}

function matrixKey(row: MappingCompanyRoleMatrixRow): string {
  return [row.companyKey, row.roleKey, row.level, row.location, row.platform].join('\u001f');
}

function formatPercent(value?: number): string {
  return value === undefined ? 'unknown' : `${Math.round(value * 1000) / 10}%`;
}
