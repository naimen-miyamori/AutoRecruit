import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlatformSelection } from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { EmptyState, ErrorState, IconButton, LoadingState, PageHeader, PLATFORM_LABELS, Section, formatCompactDate } from '../../components/ui';

export function JobsPage() {
  const [platform, setPlatform] = useState<PlatformSelection>('all');
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: queryKeys.jobs(platform), queryFn: ({ signal }) => api.listJobs(platform, signal) });
  const jobs = useMemo(() => (query.data?.jobs ?? []).filter((job) => {
    const haystack = [job.jobKey, job.searchKeyword, job.expectedJobName, job.jdTitle, job.savedSearchName, job.pageKeyword, job.location].filter(Boolean).join(' ').toLowerCase();
    return !search.trim() || haystack.includes(search.trim().toLowerCase());
  }), [query.data, search]);

  return (
    <div className="page-stack">
      <PageHeader eyebrow="TALENT DATA" title="岗位与人才" description="平台隔离的岗位、运行历史、简历与评分证据。" actions={<><Link className="primary-button" to="/run">新建搜索任务</Link><IconButton label="刷新" onClick={() => void query.refetch()}><RefreshCw size={17} /></IconButton></>} />
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      <Section>
        <div className="toolbar"><div className="toolbar-group"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as PlatformSelection)}><option value="all">全部平台</option><option value="51job">51job</option><option value="liepin">猎聘</option><option value="zhilian">智联</option><option value="boss">Boss 直聘</option></select></label><label><span>搜索岗位</span><div className="search-input"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="岗位名、jobKey、地点" /></div></label></div><strong>{jobs.length} 个岗位</strong></div>
      </Section>
      {query.isLoading && <Section><LoadingState /></Section>}
      {!query.isLoading && jobs.length === 0 && <Section><EmptyState title="没有岗位记录" description="新岗位首次运行需要 JD 文本或 JD 文件。" /></Section>}
      <div className="job-list">{jobs.map((job) => <Link className="job-row" to={`/jobs/${encodeURIComponent(job.platform)}/${encodeURIComponent(job.jobKey)}`} key={`${job.platform}-${job.jobKey}`}><div className="job-identity"><span className={`platform-mark platform-${job.platform}`}>{PLATFORM_LABELS[job.platform]}</span><h3>{job.expectedJobName ?? job.searchKeyword ?? job.jobKey}</h3><p>{job.jobKey} · JD：{job.jdTitle ?? '-'} · {job.location ?? '未设置地点'}</p></div><div className="job-stat"><span>运行</span><strong>{job.runCount}</strong></div><div className="job-stat"><span>候选人</span><strong>{job.candidateCount}</strong></div><div className="job-stat"><span>评分</span><strong>{job.scoreCount}</strong></div><div className="job-stat"><span>最近运行</span><strong>{formatCompactDate(job.latestRunAt)}</strong></div></Link>)}</div>
    </div>
  );
}
