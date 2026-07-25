import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type { Platform } from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { ArtifactButton } from '../../components/ArtifactButton';
import { EmptyState, ErrorState, IconButton, JsonViewer, LoadingState, PageHeader, PLATFORM_LABELS, Section, StatusPill, formatDate } from '../../components/ui';

const platforms = new Set(['51job', 'liepin', 'zhilian', 'boss']);

export function JobDetailPage() {
  const { platform: rawPlatform = '', jobKey = '' } = useParams();
  const platform = platforms.has(rawPlatform) ? rawPlatform as Platform : undefined;
  const jobQuery = useQuery({ queryKey: queryKeys.job(rawPlatform, jobKey), queryFn: ({ signal }) => api.getJob(rawPlatform, jobKey, signal), enabled: Boolean(platform && jobKey) });
  const runsQuery = useQuery({ queryKey: queryKeys.jobRuns(rawPlatform, jobKey), queryFn: ({ signal }) => api.listJobRuns(rawPlatform, jobKey, signal), enabled: Boolean(platform && jobKey) });
  const candidatesQuery = useQuery({ queryKey: queryKeys.candidates(rawPlatform, jobKey), queryFn: ({ signal }) => api.listCandidates(rawPlatform, jobKey, signal), enabled: Boolean(platform && jobKey) });
  const refresh = () => void Promise.all([jobQuery.refetch(), runsQuery.refetch(), candidatesQuery.refetch()]);
  if (!platform) return <ErrorState error={new Error('平台参数无效')} />;
  if (jobQuery.isLoading) return <LoadingState label="读取岗位" />;
  if (jobQuery.error) return <ErrorState error={jobQuery.error} onRetry={refresh} />;
  const job = jobQuery.data;
  if (!job) return <EmptyState title="岗位不存在" />;
  const bossPosition = job.jobRecord?.bossPosition;
  return (
    <div className="page-stack">
      <PageHeader eyebrow={PLATFORM_LABELS[platform]} title={job.title ?? job.searchKeyword ?? job.jobKey} description={job.jobKey} actions={<><Link className="secondary-button" to="/jobs"><ArrowLeft size={16} />返回岗位</Link><IconButton label="刷新" onClick={refresh}><RefreshCw size={17} /></IconButton></>} />
      <Section>
        <div className="detail-grid"><div className="detail-cell"><span>地点</span><strong>{job.location ?? '-'}</strong></div><div className="detail-cell"><span>运行 / 候选 / 评分</span><strong>{job.runCount} / {job.candidateCount} / {job.scoreCount}</strong></div><div className="detail-cell"><span>最近运行</span><strong>{formatDate(job.latestRunAt)}</strong></div><div className="detail-cell"><span>报告邮箱</span><strong>{job.recipientEmail ?? '-'}</strong></div>{bossPosition && <><div className="detail-cell"><span>Boss Job ID</span><strong className="mono">{bossPosition.bossJobId}</strong></div><div className="detail-cell"><span>职位状态</span><strong>{bossPosition.status}</strong></div><div className="detail-cell"><span>JD Hash</span><strong className="mono">{bossPosition.sourceHash}</strong></div><div className="detail-cell"><span>最后同步</span><strong>{formatDate(bossPosition.syncedAt)}</strong></div></>}</div>
        {job.artifacts.length > 0 && <div className="form-actions">{job.artifacts.map((artifact) => <ArtifactButton artifact={artifact} key={artifact.artifactId} />)}</div>}
      </Section>
      <div className="two-column"><Section title="职位说明"><div className="snapshot-viewer">{job.rawText ?? '无 JD 文本'}</div></Section><Section title="结构化职位"><JsonViewer value={job.normalizedJob ?? {}} /></Section></div>
      <Section title="完整运行历史" description={`${runsQuery.data?.runs.length ?? 0} 次运行`}>
        {runsQuery.isLoading && <LoadingState />}
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>总候选</th><th>新增</th><th>已评分</th><th>失败</th><th>结果文件</th></tr></thead><tbody>{runsQuery.data?.runs.map((run) => <tr key={`${run.fetchedAt}-${run.resultFile ?? ''}`}><td>{formatDate(run.fetchedAt)}</td><td>{run.totalCandidates}</td><td>{run.newCandidateIds.length}</td><td>{run.scoredCandidates.length}</td><td><StatusPill status={run.failedCandidates.length ? 'failed' : 'succeeded'} label={String(run.failedCandidates.length)} /></td><td className="mono">{run.resultFile ?? '-'}</td></tr>)}</tbody></table></div>
        {!runsQuery.isLoading && !runsQuery.data?.runs.length && <EmptyState title="还没有运行历史" />}
      </Section>
      <Section title="候选人" description="按评分从高到低"><div className="table-wrap"><table><thead><tr><th>姓名</th><th>年龄</th><th>学历</th><th>地区</th><th>当前经历</th><th>评分</th><th></th></tr></thead><tbody>{candidatesQuery.data?.candidates.map((candidate) => <tr key={candidate.candidateId}><td><strong>{candidate.name ?? candidate.candidateId}</strong><small className="mono">{candidate.candidateId}</small></td><td>{candidate.age ?? '-'}</td><td>{candidate.education ?? '-'}</td><td>{candidate.regions.join('、') || '-'}</td><td>{[candidate.currentCompany, candidate.currentTitle].filter(Boolean).join(' / ') || '-'}</td><td>{candidate.score?.totalScore ?? <StatusPill status={candidate.score?.status === 'failed' ? 'failed' : 'neutral'} label={candidate.score?.status ?? '未评分'} />}</td><td><Link className="text-link" to={`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}/candidates/${encodeURIComponent(candidate.candidateId)}`}>详情</Link></td></tr>)}</tbody></table></div>{!candidatesQuery.isLoading && !candidatesQuery.data?.candidates.length && <EmptyState title="暂无候选人" />}</Section>
    </div>
  );
}
