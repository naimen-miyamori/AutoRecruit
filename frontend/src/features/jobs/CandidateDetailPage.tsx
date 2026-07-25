import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, queryKeys } from '../../api/client';
import { ArtifactButton } from '../../components/ArtifactButton';
import { EmptyState, ErrorState, IconButton, JsonViewer, LoadingState, PageHeader, Section, StatusPill } from '../../components/ui';

export function CandidateDetailPage() {
  const { platform = '', jobKey = '', candidateId = '' } = useParams();
  const query = useQuery({ queryKey: queryKeys.candidate(platform, jobKey, candidateId), queryFn: ({ signal }) => api.getCandidate(platform, jobKey, candidateId, signal), enabled: Boolean(platform && jobKey && candidateId) });
  if (query.isLoading) return <LoadingState label="读取候选人" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const candidate = query.data;
  if (!candidate) return <EmptyState title="候选人不存在" />;
  return (
    <div className="page-stack">
      <PageHeader eyebrow="CANDIDATE EVIDENCE" title={candidate.name ?? candidate.candidateId} description={`${candidate.platform} · ${candidate.candidateId}`} actions={<><Link className="secondary-button" to={`/jobs/${encodeURIComponent(platform)}/${encodeURIComponent(jobKey)}`}><ArrowLeft size={16} />返回岗位</Link><IconButton label="刷新" onClick={() => void query.refetch()}><RefreshCw size={17} /></IconButton></>} />
      <Section><div className="detail-grid"><div className="detail-cell"><span>年龄</span><strong>{candidate.age ?? '-'}</strong></div><div className="detail-cell"><span>学历</span><strong>{candidate.education ?? '-'}</strong></div><div className="detail-cell"><span>地区</span><strong>{candidate.regions.join('、') || '-'}</strong></div><div className="detail-cell"><span>评分</span><strong>{candidate.score?.totalScore ?? <StatusPill status={candidate.score?.status === 'failed' ? 'failed' : 'neutral'} label={candidate.score?.status ?? '未评分'} />}</strong></div></div><div className="form-actions">{candidate.artifacts.map((artifact) => <ArtifactButton artifact={artifact} key={artifact.artifactId} />)}</div></Section>
      <div className="two-column"><Section title="结构化简历"><JsonViewer value={candidate.resume} /></Section><Section title="评分证据"><JsonViewer value={candidate.score?.artifact ?? candidate.score ?? {}} /></Section></div>
      <Section title="原始文本快照" description={candidate.snapshotPath ?? '无快照'}>{candidate.snapshotPreview ? <pre className="snapshot-viewer">{candidate.snapshotPreview}</pre> : <EmptyState title="无文本快照" />}</Section>
    </div>
  );
}
