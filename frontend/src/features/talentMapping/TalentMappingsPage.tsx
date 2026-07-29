import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, CheckCircle2, GitCompareArrows, Link2, ListTree, Map as MapIcon, Play, RefreshCw, Search, ShieldAlert, Sparkles, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  MappingCandidateView,
  MappingClassificationSuggestionView,
  MappingCompanyRoleMatrixRow,
  MappingCoverageViewRow,
  MappingEntityLinkReviewView,
  MappingRunChangeReport,
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

type MappingTab = 'overview' | 'companies' | 'candidates' | 'changes' | 'entities' | 'classification' | 'runs' | 'settings';

const MAPPING_TABS: Array<[MappingTab, string]> = [
  ['overview', '概览'],
  ['companies', '公司矩阵'],
  ['candidates', '人才清单'],
  ['changes', '历次变化'],
  ['entities', '实体关联'],
  ['classification', '分类审核'],
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
  const entityLinksQuery = useQuery({
    queryKey: queryKeys.talentMappingEntityLinks(mappingKey),
    queryFn: ({ signal }) => api.getTalentMappingEntityLinks(mappingKey, signal),
  });
  const classificationsQuery = useQuery({
    queryKey: queryKeys.talentMappingClassifications(mappingKey),
    queryFn: ({ signal }) => api.listTalentMappingClassificationSuggestions(mappingKey, signal),
  });
  const taskMutation = useMutation({ mutationFn: (body: Record<string, unknown>) => api.submitTalentMapping(body) });
  const detail = detailQuery.data;
  const platformSelection = detail?.detailSelection.platformSelection
    ?? detail?.summary.latestRun?.platformSelection
    ?? (detail?.summary.platforms.length === 1 ? detail.summary.platforms[0] : 'all');
  const refreshAll = async () => {
    await Promise.all([
      detailQuery.refetch(), runsQuery.refetch(), candidatesQuery.refetch(), companiesQuery.refetch(), coverageQuery.refetch(), entityLinksQuery.refetch(), classificationsQuery.refetch(),
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
      {queryError(runsQuery.error, candidatesQuery.error, companiesQuery.error, coverageQuery.error, entityLinksQuery.error, classificationsQuery.error)}
      {tab === 'overview' && <MappingOverview detail={detail} coverage={coverageQuery.data?.coverage ?? []} loading={coverageQuery.isLoading} />}
      {tab === 'companies' && <CompanyMatrix rows={companiesQuery.data?.companies ?? []} loading={companiesQuery.isLoading} />}
      {tab === 'candidates' && <CandidateList candidates={candidatesQuery.data?.candidates ?? []} loading={candidatesQuery.isLoading} />}
      {tab === 'changes' && <MappingChanges mappingKey={mappingKey} runs={runsQuery.data?.runs ?? []} />}
      {tab === 'entities' && <MappingEntityReview mappingKey={mappingKey} candidates={candidatesQuery.data?.candidates ?? []} review={entityLinksQuery.data?.entityLinks} loading={entityLinksQuery.isLoading} onChanged={refreshAll} />}
      {tab === 'classification' && <MappingClassificationReview mappingKey={mappingKey} suggestions={classificationsQuery.data?.suggestions ?? []} loading={classificationsQuery.isLoading} onChanged={refreshAll} />}
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
        <Metric label="人工确认实体" value={summary.confirmedEntityCount} note={`${summary.activeEntityLinkCount} 条有效关联`} icon={<Link2 size={16} />} />
        <Metric label="详情已补全" value={summary.enrichedCandidateCount} note={formatPercent(detailRate)} tone="success" icon={<CheckCircle2 size={16} />} />
        <Metric label="待归类档案" value={summary.unclassifiedCandidateCount} tone={summary.unclassifiedCandidateCount ? 'warning' : 'success'} icon={<ListTree size={16} />} />
        <Metric label="待审核分类建议" value={summary.pendingClassificationSuggestionCount} tone={summary.pendingClassificationSuggestionCount ? 'warning' : 'success'} icon={<Sparkles size={16} />} />
        <Metric label="公司矩阵单元" value={summary.companyMatrixRowCount} icon={<Building2 size={16} />} />
        <Metric label="搜索切片" value={summary.sliceCount} icon={<MapIcon size={16} />} />
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
    const haystack = [candidate.platformCandidateKey, candidate.entityId, candidate.name, candidate.currentCompany, candidate.currentTitle, candidate.companyKey, candidate.roleKey, candidate.level, candidate.location, candidate.manualClassification?.reviewedBy, ...candidate.sourceSliceIds].filter(Boolean).join(' ').toLowerCase();
    return matchesPlatform && matchesDetail && (!search.trim() || haystack.includes(search.trim().toLowerCase()));
  }), [candidates, detailStatus, platform, search]);
  return <Section title="人才清单" description="平台 identity 是唯一执行身份；只有人工确认的实体关联影响实体口径，人工接受的模型建议只填补待归类字段。" actions={<div className="filter-row"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as typeof platform)}><option value="all">全部主平台</option><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option></select></label><label><span>详情状态</span><select value={detailStatus} onChange={(event) => setDetailStatus(event.target.value as typeof detailStatus)}><option value="all">全部</option><option value="not-enriched">未补全</option><option value="enriched">已补全</option></select></label><label><span>搜索人才</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="身份、实体、公司、岗位、切片" /></label></div>}>{loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState title="没有匹配的人才档案" /> : <div className="table-wrap"><table><thead><tr><th>平台身份</th><th>当前公司 / 岗位</th><th>岗位族 / 职级</th><th>地域</th><th>人工审核</th><th>来源切片</th><th>首次 / 最近观察</th><th>详情</th></tr></thead><tbody>{filtered.map((candidate) => <tr key={candidate.platformCandidateKey}><td><div className="cell-main"><span className={`platform-mark platform-${candidate.platform}`}>{PLATFORM_LABELS[candidate.platform]}</span><strong>{candidate.name ?? '未命名候选人'}</strong><small className="mono">{candidate.platformCandidateKey}</small></div></td><td><div className="cell-main"><strong>{candidate.currentCompany ?? '待归类'}</strong><small>{candidate.currentTitle ?? '待归类'}</small></div></td><td>{candidate.roleKey ?? '待归类'}<small>{candidate.level ?? '待归类'}</small></td><td>{candidate.location ?? '待归类'}</td><td><div className="cell-main"><strong>{candidate.entityId ? `实体 ${candidate.entityId.slice(0, 8)}` : '未关联'}</strong><small>{candidate.manualClassification ? `分类：${candidate.manualClassification.fields.join('、')} · ${candidate.manualClassification.reviewedBy}` : '无人工分类'}</small></div></td><td>{candidate.sourceSliceIds.join('、')}</td><td>{formatCompactDate(candidate.firstObservedAt)}<small>{formatCompactDate(candidate.lastObservedAt)}</small></td><td><StatusPill status={candidate.detailStatus === 'enriched' ? 'succeeded' : 'neutral'} label={candidate.detailStatus === 'enriched' ? '已补全' : '未补全'} /></td></tr>)}</tbody></table></div>}</Section>;
}

function MappingChanges({ mappingKey, runs }: { mappingKey: string; runs: MappingRunRecord[] }) {
  const eligibleRuns = runs.filter((run) => run.status !== 'failed' && (run.stage === 'scan' || run.stage === 'all'));
  const [baseRunId, setBaseRunId] = useState('');
  const [compareRunId, setCompareRunId] = useState('');
  const changesQuery = useQuery({
    queryKey: queryKeys.talentMappingChanges(mappingKey, baseRunId || undefined, compareRunId || undefined),
    queryFn: ({ signal }) => api.getTalentMappingChanges(mappingKey, baseRunId || undefined, compareRunId || undefined, signal),
  });
  const report = changesQuery.data?.changes;
  return (
    <div className="page-stack">
      <Section title="运行对比" description="默认比较最近两次成功 scan/all；也可选择明确的基准与对比运行。" actions={<div className="filter-row"><label><span>基准运行</span><select value={baseRunId} onChange={(event) => setBaseRunId(event.target.value)}><option value="">自动选择</option>{eligibleRuns.map((run) => <option value={run.runId} key={run.runId}>{formatCompactDate(run.finishedAt)} · {run.runId}</option>)}</select></label><label><span>对比运行</span><select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}><option value="">自动选择最新</option>{eligibleRuns.map((run) => <option value={run.runId} key={run.runId}>{formatCompactDate(run.finishedAt)} · {run.runId}</option>)}</select></label></div>}>
        {changesQuery.isLoading ? <LoadingState label="生成变化对比" /> : changesQuery.error ? <ErrorState error={changesQuery.error} /> : report && <ChangeReport report={report} />}
      </Section>
    </div>
  );
}

function ChangeReport({ report }: { report: MappingRunChangeReport }) {
  if (report.status === 'insufficient-runs') {
    return <EmptyState title="至少需要两次成功扫描" description="完成第二次 scan/all 后才会生成历次变化报告。" />;
  }
  return <div className="page-stack"><div className="mapping-policy-banner"><GitCompareArrows size={20} /><div><strong>{report.baseRunId} → {report.compareRunId}</strong><span>{report.caveat}</span></div></div><div className="metric-grid"><Metric label="新观察档案" value={report.newProfiles.length} /><Metric label="明确字段变化" value={report.changedProfiles.length} /><Metric label="本轮未再次观察" value={report.notObservedProfiles.length} tone={report.notObservedProfiles.length ? 'warning' : 'success'} /><Metric label="未变化档案" value={report.unchangedProfiles} /></div><Section title="明确字段变化" description="只比较运行内有页面证据的姓名、公司、岗位、归一化岗位族/职级和地域字段。">{report.changedProfiles.length === 0 ? <EmptyState title="没有明确字段变化" /> : <div className="compact-list">{report.changedProfiles.map((candidate) => <div className="compact-item" key={candidate.platformCandidateKey}><StatusPill status="warning" label={PLATFORM_LABELS[candidate.platform]} /><div><strong className="mono">{candidate.platformCandidateKey}</strong><small>{candidate.fields.map((field) => `${field.field}: ${field.previousValue ?? '空'} → ${field.currentValue ?? '空'}`).join('\n')}</small></div></div>)}</div>}</Section><div className="two-column"><Section title="新观察档案">{report.newProfiles.length === 0 ? <EmptyState title="无新增观察" /> : <div className="compact-list">{report.newProfiles.map((candidate) => <div className="compact-item" key={candidate.platformCandidateKey}><strong className="mono">{candidate.platformCandidateKey}</strong><small>{candidate.currentCompany ?? '-'} · {candidate.currentTitle ?? '-'}</small></div>)}</div>}</Section><Section title="本轮未再次观察" description="不代表离职、跳槽或不再求职。">{report.notObservedProfiles.length === 0 ? <EmptyState title="无未再次观察档案" /> : <div className="compact-list">{report.notObservedProfiles.map((candidate) => <div className="compact-item" key={candidate.platformCandidateKey}><strong className="mono">{candidate.platformCandidateKey}</strong><small>{candidate.currentCompany ?? '-'} · {candidate.currentTitle ?? '-'}</small></div>)}</div>}</Section></div></div>;
}

function MappingEntityReview({ mappingKey, candidates, review, loading, onChanged }: {
  mappingKey: string;
  candidates: MappingCandidateView[];
  review?: MappingEntityLinkReviewView;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [reviewer, setReviewer] = useState('');
  const [evidence, setEvidence] = useState('');
  const [revocationReason, setRevocationReason] = useState('');
  const candidateByKey = useMemo(() => new Map(candidates.map((candidate) => [candidate.platformCandidateKey, candidate])), [candidates]);
  const confirmMutation = useMutation({
    mutationFn: (platformCandidateKeys: string[]) => api.confirmTalentMappingEntityLink(mappingKey, { platformCandidateKeys, confirmedBy: reviewer.trim(), evidence: evidence.trim() }),
    onSuccess: () => void onChanged(),
  });
  const revokeMutation = useMutation({
    mutationFn: (entityId: string) => api.revokeTalentMappingEntityLink(mappingKey, entityId, { revokedBy: reviewer.trim(), reason: revocationReason.trim() }),
    onSuccess: () => void onChanged(),
  });
  const candidateLabel = (key: string) => {
    const candidate = candidateByKey.get(key);
    return candidate ? `${PLATFORM_LABELS[candidate.platform]} · ${candidate.name ?? key} · ${candidate.currentCompany ?? '公司未知'} · ${candidate.currentTitle ?? '岗位未知'}` : key;
  };
  if (loading) return <Section><LoadingState label="读取人工实体关联" /></Section>;
  if (!review) return <Section><EmptyState title="暂无实体关联数据" /></Section>;
  const canConfirm = Boolean(reviewer.trim() && evidence.trim());
  const canRevoke = Boolean(reviewer.trim() && revocationReason.trim());
  return <div className="page-stack"><div className="mapping-policy-banner"><Link2 size={20} /><div><strong>只接受人工确认的跨平台关系</strong><span>候选建议不会自动合并，也不会改变详情打开目标；确认和撤销都会保留审核人、时间和证据。</span></div></div><div className="metric-grid"><Metric label="平台唯一档案" value={review.platformProfileCount} /><Metric label="人工确认实体" value={review.confirmedEntityCount} /><Metric label="有效关联" value={review.activeLinks.length} /><Metric label="待审核线索" value={review.suggestions.length} /></div><Section title="审核信息" description="确认或撤销前必须填写审核人和证据/原因。"><div className="form-grid"><label><span>审核人</span><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="姓名或团队标识" /></label><label><span>确认依据</span><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="人工核对的页面或履历依据" /></label><label><span>撤销原因</span><input value={revocationReason} onChange={(event) => setRevocationReason(event.target.value)} placeholder="仅撤销时使用" /></label></div></Section>{(confirmMutation.error || revokeMutation.error) && <ErrorState error={confirmMutation.error ?? revokeMutation.error} />}<Section title="可能关联线索" description="线索只基于跨平台姓名完全一致并至少有公司或岗位一致；仍必须人工核对。">{review.suggestions.length === 0 ? <EmptyState title="没有待审核关联线索" /> : <div className="compact-list">{review.suggestions.map((suggestion) => <div className="compact-item" key={suggestion.suggestionId}><div><strong>{suggestion.platformCandidateKeys.map(candidateLabel).join(' ↔ ')}</strong><small>{suggestion.evidence.join('、')}</small></div><SafetyDialog trigger={<button className="primary-button" type="button" disabled={!canConfirm || confirmMutation.isPending}>确认同一实体</button>} title="确认跨平台同一实体" description="该操作会改变“人工关联后实体数”，但不会合并平台原始档案或改变执行目标。" tone="warning" facts={[{ label: '候选身份', value: suggestion.platformCandidateKeys.join(' ↔ ') }, { label: '审核人', value: reviewer || '-' }, { label: '人工依据', value: evidence || '-' }]} confirmLabel="确认关联" busy={confirmMutation.isPending} onConfirm={() => confirmMutation.mutate(suggestion.platformCandidateKeys)} /></div>)}</div>}</Section><Section title="已确认实体关联">{review.activeLinks.length === 0 ? <EmptyState title="尚无人工确认关联" /> : <div className="compact-list">{review.activeLinks.map((link) => <div className="compact-item" key={link.entityId}><div><strong>{link.platformCandidateKeys.map(candidateLabel).join(' ↔ ')}</strong><small>{link.confirmedBy} · {formatDate(link.confirmedAt)} · {link.evidence}</small><small className="mono">{link.entityId}</small></div><SafetyDialog trigger={<button className="danger-button" type="button" disabled={!canRevoke || revokeMutation.isPending}>撤销关联</button>} title="撤销跨平台实体关联" description="撤销会恢复各平台独立实体计数，并保留原确认记录和本次撤销原因。" facts={[{ label: 'Entity ID', value: link.entityId }, { label: '审核人', value: reviewer || '-' }, { label: '撤销原因', value: revocationReason || '-' }]} confirmLabel="确认撤销" busy={revokeMutation.isPending} onConfirm={() => revokeMutation.mutate(link.entityId)} /></div>)}</div>}</Section></div>;
}

function MappingClassificationReview({ mappingKey, suggestions, loading, onChanged }: {
  mappingKey: string;
  suggestions: MappingClassificationSuggestionView[];
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [reviewer, setReviewer] = useState('');
  const [note, setNote] = useState('');
  const generateMutation = useMutation({ mutationFn: () => api.generateTalentMappingClassificationSuggestions(mappingKey, 25) });
  const reviewMutation = useMutation({
    mutationFn: ({ suggestionId, decision }: { suggestionId: string; decision: 'accepted' | 'rejected' }) => api.reviewTalentMappingClassificationSuggestion(mappingKey, suggestionId, { decision, reviewedBy: reviewer.trim(), note: note.trim() || undefined }),
    onSuccess: () => void onChanged(),
  });
  if (loading) return <Section><LoadingState label="读取分类建议" /></Section>;
  const pending = suggestions.filter((suggestion) => !suggestion.review);
  return <div className="page-stack"><div className="mapping-policy-banner"><Sparkles size={20} /><div><strong>模型只生成待审核建议</strong><span>模型输入仅包含截断的公司、职位和由确定性规则确认的地域；不包含姓名、候选 ID、卡片全文或简历。建议只有人工接受后才填补仍为空的归一化字段。</span></div></div><Section title="生成建议" description="使用运行环境中的 OPENAI_API_KEY 和 TALENT_MAPPING_MODEL/OPENAI_MODEL，通过共享 TaskQueue 串行执行。" actions={<button className="secondary-button" type="button" disabled={generateMutation.isPending} onClick={() => generateMutation.mutate()}><Sparkles size={15} />生成最多 25 条建议</button>}><div className="form-grid"><label><span>审核人</span><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="接受或拒绝建议时必填" /></label><label><span>审核备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选，记录人工判断依据" /></label></div>{generateMutation.data && <SuccessNotice><CheckCircle2 size={18} />分类建议任务已入队：<Link className="text-link" to={`/tasks/${encodeURIComponent(generateMutation.data.taskId)}`}>{generateMutation.data.taskId}</Link></SuccessNotice>}{(generateMutation.error || reviewMutation.error) && <ErrorState error={generateMutation.error ?? reviewMutation.error} />}</Section><Section title={`待审核建议（${pending.length}）`} description="输出值已被服务端限制在计划声明的公司、岗位族、职级和地域集合内。">{pending.length === 0 ? <EmptyState title="没有待审核分类建议" /> : <div className="compact-list">{pending.map((suggestion) => <div className="compact-item" key={suggestion.suggestionId}><div><strong className="mono">{suggestion.platformCandidateKey}</strong><small>{Object.entries(suggestion.proposed).map(([field, value]) => `${field}=${value}`).join(' · ')}</small><small>{suggestion.rationale || '模型未提供理由'} · 模型 {suggestion.model}</small><small>证据：{suggestion.evidence.map((item) => `${item.field}:${item.rawValue}`).join('；')}</small></div><div className="page-actions"><SafetyDialog trigger={<button className="primary-button" type="button" disabled={!reviewer.trim() || reviewMutation.isPending}>接受</button>} title="接受分类建议" description="接受后只填补当前仍为空的归一化字段，并记录人工审核来源；模型建议本身不成为页面事实。" tone="warning" facts={[{ label: '候选身份', value: suggestion.platformCandidateKey }, { label: '建议字段', value: Object.entries(suggestion.proposed).map(([field, value]) => `${field}=${value}`).join(' · ') }, { label: '审核人', value: reviewer || '-' }]} confirmLabel="确认接受" busy={reviewMutation.isPending} onConfirm={() => reviewMutation.mutate({ suggestionId: suggestion.suggestionId, decision: 'accepted' })} /><button className="secondary-button" type="button" disabled={!reviewer.trim() || reviewMutation.isPending} onClick={() => reviewMutation.mutate({ suggestionId: suggestion.suggestionId, decision: 'rejected' })}>拒绝</button></div></div>)}</div>}</Section><Section title="已审核记录">{suggestions.filter((suggestion) => suggestion.review).length === 0 ? <EmptyState title="暂无已审核建议" /> : <div className="compact-list">{suggestions.filter((suggestion) => suggestion.review).map((suggestion) => <div className="compact-item" key={suggestion.suggestionId}><StatusPill status={suggestion.review?.decision === 'accepted' ? 'succeeded' : 'neutral'} label={suggestion.review?.decision} /><div><strong className="mono">{suggestion.platformCandidateKey}</strong><small>{suggestion.review?.reviewedBy} · {formatDate(suggestion.review?.reviewedAt)} · {suggestion.review?.note ?? '无备注'}</small></div></div>)}</div>}</Section></div>;
}

function MappingRuns({ runs, loading }: { runs: MappingRunRecord[]; loading: boolean }) {
  const rows = runs.flatMap((run) => run.sliceRuns.map((sliceRun) => ({ run, sliceRun })));
  return <Section title="运行记录" description="失败运行保留已写 observation 和 checkpoint；completed-with-gaps 仍会显式显示 capped 或详情缺口。">{loading ? <LoadingState /> : rows.length === 0 ? <EmptyState title="暂无运行记录" /> : <div className="table-wrap"><table><thead><tr><th>运行 / 阶段</th><th>切片 / 平台</th><th>卡片 / 唯一档案</th><th>详情</th><th>失败详情</th><th>终止原因</th><th>状态</th><th>完成时间</th></tr></thead><tbody>{rows.map(({ run, sliceRun }) => <tr key={`${run.runId}-${sliceRun.sliceId}-${sliceRun.platform}`}><td><div className="cell-main"><strong>{run.stage}</strong><small className="mono">{run.runId}</small></div></td><td><div className="cell-main"><strong>{sliceRun.sliceId}</strong><small>{PLATFORM_LABELS[sliceRun.platform]}</small></div></td><td>{sliceRun.observedCards} / {sliceRun.uniquePlatformProfiles}<small>{sliceRun.scannedBatches} 批次</small></td><td>{sliceRun.enrichedProfiles}/{sliceRun.eligibleForDetail}</td><td>{sliceRun.failedProfiles.length}{sliceRun.error && <small>{sliceRun.error}</small>}</td><td>{sliceRun.terminationReason}</td><td><StatusPill status={sliceRun.status === 'failed' ? 'failed' : sliceRun.status === 'completed-with-gaps' ? 'warning' : 'succeeded'} label={sliceRun.status} /></td><td>{formatDate(sliceRun.finishedAt)}</td></tr>)}</tbody></table></div>}</Section>;
}

function MappingSettings({ detail }: { detail: TalentMappingProjectDetail }) {
  const project = detail.project;
  return <div className="two-column"><Section title="权威计划" description="项目设置只读；版本化 JSON 文件仍是执行输入。"><div className="detail-grid"><div className="detail-cell"><span>版本</span><strong>v{project.version}</strong></div><div className="detail-cell"><span>完整性</span><strong>{project.enrichment.mode === 'card-only' ? '市场扫描 / Mapping 初筛' : project.enrichment.mode}</strong></div><div className="detail-cell"><span>批次上限</span><strong>{project.coverage.maxBatchesPerSlice}/切片</strong></div><div className="detail-cell"><span>候选上限</span><strong>{project.coverage.maxCandidatesPerSlice}/切片</strong></div></div><div className="detail-cell settings-source"><span>计划文件</span><strong className="mono">{project.sourceFilePath}</strong></div><JsonViewer value={{ objective: project.objective, taxonomy: project.taxonomy, coverage: project.coverage, enrichment: project.enrichment }} /></Section><Section title="搜索切片" description="相对 searchPlanFile 已在服务端按 Mapping 文件目录解析。"><div className="compact-list">{project.slices.map((slice) => <div className="compact-item mapping-slice-setting" key={slice.sliceId}><div><strong>{slice.label}</strong><small className="mono">{slice.sliceId}</small><small>{(['51job', 'liepin', 'zhilian'] as const).map((platform) => { const plan = slice.platformPlans[platform]; return `${PLATFORM_LABELS[platform]}: ${!plan ? '未配置' : plan.disabled ? `禁用（${plan.reason}）` : `${plan.searchSource} · ${plan.searchPlanFile}`}`; }).join('\n')}</small></div></div>)}</div></Section></div>;
}

function matrixKey(row: MappingCompanyRoleMatrixRow): string {
  return [row.companyKey, row.roleKey, row.level, row.location, row.platform].join('\u001f');
}

function formatPercent(value?: number): string {
  return value === undefined ? 'unknown' : `${Math.round(value * 1000) / 10}%`;
}
