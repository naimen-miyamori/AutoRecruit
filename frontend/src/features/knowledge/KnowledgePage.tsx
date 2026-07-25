import { useMutation, useQuery } from '@tanstack/react-query';
import { Database, Play, Search } from 'lucide-react';
import { useState } from 'react';
import type { Platform } from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { modelConfigForRequest } from '../../api/model-settings';
import { ErrorState, PageHeader, PLATFORM_LABELS, Section, SuccessNotice } from '../../components/ui';

type RagMode = 'stored' | 'temporary';
type OpsAction = 'doctor' | 'review' | 'metrics' | 'ops' | 'rebuild';

export function KnowledgePage() {
  const [tab, setTab] = useState<'answer' | 'ops' | 'catalog'>('answer');
  const [mode, setMode] = useState<RagMode>('stored');
  const [platform, setPlatform] = useState<Platform>('51job');
  const [jobKey, setJobKey] = useState('');
  const [keyword, setKeyword] = useState('');
  const [question, setQuestion] = useState('');
  const [jd, setJd] = useState('');
  const [jdFile, setJdFile] = useState('');
  const answerMutation = useMutation({ mutationFn: () => api.askRag({ platform, jobKey: jobKey.trim() || undefined, keyword: keyword.trim() || undefined, question: question.trim(), ...(mode === 'temporary' ? { jd: jd.trim() || undefined, jdFile: jdFile.trim() || undefined } : { topK: 5, autoIndex: true, logAnswer: true }), modelConfig: modelConfigForRequest() }) });
  const [action, setAction] = useState<OpsAction>('doctor');
  const [file, setFile] = useState('');
  const [reviewer, setReviewer] = useState('');
  const opsMutation = useMutation({ mutationFn: () => api.submitTask('rag-ops', { action, platform: ['doctor', 'review', 'rebuild'].includes(action) ? platform : undefined, jobKey: jobKey.trim() || undefined, keyword: keyword.trim() || undefined, question: action === 'doctor' || action === 'ops' ? question.trim() || undefined : undefined, file: action === 'metrics' || action === 'ops' ? file.trim() : undefined, reviewer: action === 'review' || action === 'ops' ? reviewer.trim() || undefined : undefined }) });
  const catalogsQuery = useQuery({ queryKey: queryKeys.filterCatalogs(), queryFn: ({ signal }) => api.listFilterCatalogs(undefined, signal), enabled: tab === 'catalog' });
  const answer = answerMutation.data;
  return (
    <div className="page-stack">
      <PageHeader eyebrow="KNOWLEDGE" title="知识与运营" description="候选人问答、可信来源和可排队的 RAG 质量运维。" />
      <Section><div className="tabs"><button className={tab === 'answer' ? 'active' : ''} type="button" onClick={() => setTab('answer')}>候选人问答</button><button className={tab === 'ops' ? 'active' : ''} type="button" onClick={() => setTab('ops')}>RAG 运维</button><button className={tab === 'catalog' ? 'active' : ''} type="button" onClick={() => setTab('catalog')}>筛选目录</button></div></Section>
      {tab === 'answer' && <>
        <Section title="提出问题" description={mode === 'temporary' ? '临时 JD 不创建岗位、不写持久索引，也不追加生产 answer log。' : '已存岗位复用平台隔离的持久化 RAG。'}><div className="segmented"><button type="button" className={mode === 'stored' ? 'active' : ''} onClick={() => setMode('stored')}>已存岗位</button><button type="button" className={mode === 'temporary' ? 'active' : ''} onClick={() => setMode('temporary')}>临时 JD</button></div><div className="form-grid"><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{(['51job', 'liepin', 'zhilian', 'boss'] as Platform[]).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item]}</option>)}</select></label><label><span>岗位 Key</span><input value={jobKey} onChange={(event) => setJobKey(event.target.value)} /></label><label><span>关键词</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>{mode === 'temporary' && <><label className="wide"><span>JD 文本</span><textarea value={jd} onChange={(event) => setJd(event.target.value)} /></label><label><span>JD 文件</span><input value={jdFile} onChange={(event) => setJdFile(event.target.value)} /></label></>}<label className="wide"><span>候选人问题</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} /></label></div><div className="form-actions"><button className="primary-button" type="button" disabled={answerMutation.isPending || !question.trim()} onClick={() => answerMutation.mutate()}><Search size={16} />提问</button></div>{answerMutation.error && <ErrorState error={answerMutation.error} />}</Section>
        {answer && <Section title="回答结果"><div className={answer.answered === false ? 'answer no-answer' : 'answer'}><h3>{answer.answered === false ? '未找到可信答案' : '已回答'}</h3><p>{answer.answer}</p><small>置信度：{answer.confidence ?? '-'} {answer.noAnswerReason ? `· ${answer.noAnswerReason}` : ''}</small></div><div className="card-list">{answer.sources.map((source) => <article className="source-card" key={source.id}><strong>{source.label} · {Math.round(source.score * 100)}%</strong><p>{source.text}</p></article>)}</div></Section>}
      </>}
      {tab === 'ops' && <Section title="RAG 运维任务" description="离线质量循环不会写生产回答日志。"><div className="segmented">{(['doctor', 'review', 'metrics', 'ops', 'rebuild'] as OpsAction[]).map((item) => <button type="button" className={action === item ? 'active' : ''} key={item} onClick={() => setAction(item)}>{item}</button>)}</div><div className="form-grid">{['doctor', 'review', 'rebuild'].includes(action) && <><label><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{(['51job', 'liepin', 'zhilian', 'boss'] as Platform[]).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item]}</option>)}</select></label><label><span>岗位 Key</span><input value={jobKey} onChange={(event) => setJobKey(event.target.value)} /></label><label><span>关键词</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label></>}{['metrics', 'ops'].includes(action) && <label><span>岗位列表文件</span><input value={file} onChange={(event) => setFile(event.target.value)} /></label>}{['doctor', 'ops'].includes(action) && <label><span>诊断问题</span><input value={question} onChange={(event) => setQuestion(event.target.value)} /></label>}{['review', 'ops'].includes(action) && <label><span>复核人</span><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></label>}</div><div className="form-actions"><button className="primary-button" type="button" disabled={opsMutation.isPending} onClick={() => opsMutation.mutate()}><Play size={16} />创建运维任务</button></div>{opsMutation.data && <SuccessNotice>任务已创建：{opsMutation.data.taskId}</SuccessNotice>}{opsMutation.error && <ErrorState error={opsMutation.error} />}</Section>}
      {tab === 'catalog' && <Section title="平台筛选目录" description="目录只反映已发现并持久化的最新筛选状态。"><div className="table-wrap"><table><thead><tr><th>平台</th><th>关键词</th><th>捕获时间</th><th>字段</th><th>选项</th><th>失败</th></tr></thead><tbody>{catalogsQuery.data?.catalogs.map((catalog) => <tr key={`${catalog.platform}-${catalog.capturedAt}`}><td>{PLATFORM_LABELS[catalog.platform]}</td><td>{catalog.keyword}</td><td>{catalog.capturedAt}</td><td>{catalog.stats.discoveredControls}</td><td>{catalog.stats.optionsExtracted}</td><td>{catalog.stats.failedControls}</td></tr>)}</tbody></table></div><Database size={18} /></Section>}
    </div>
  );
}
