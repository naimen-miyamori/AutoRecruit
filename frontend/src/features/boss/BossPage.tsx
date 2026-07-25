import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BriefcaseBusiness, Download, MessageSquareText, RefreshCw, Search, Send, ShieldCheck, Sparkles, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  BossChatOperation,
  BossChatOperationResult,
  BossJobSyncRun,
  BossTalentSearchResult,
  TaskDetail,
  ArtifactDescriptor,
} from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { ArtifactButton } from '../../components/ArtifactButton';
import { SafetyDialog } from '../../components/SafetyDialog';
import { EmptyState, ErrorState, IconButton, JsonViewer, LoadingState, PageHeader, Section, StatusPill, SuccessNotice, formatDate } from '../../components/ui';

type BossTab = 'positions' | 'talent' | 'conversations' | 'reviews' | 'receipts';

export function BossPage() {
  const [tab, setTab] = useState<BossTab>('positions');
  return (
    <div className="page-stack boss-workbench">
      <PageHeader eyebrow="BOSS ONLY" title="Boss 工作台" description="Boss 始终是独立单平台；所有在线读取和变更都通过共享任务队列。" />
      <div className="boss-banner"><ShieldCheck size={20} /><div><strong>安全边界</strong><span>读取不会消耗匹配次数；立即匹配、打招呼和聊天变更需要精确身份、confirmed 与 intent ID。</span></div></div>
      <Section><div className="tabs">{([['positions', '职位/JD'], ['talent', '人才发现'], ['conversations', '会话中心'], ['reviews', '自动沟通审核'], ['receipts', '操作回执']] as const).map(([value, label]) => <button type="button" className={tab === value ? 'active' : ''} key={value} onClick={() => setTab(value)}>{label}</button>)}</div></Section>
      {tab === 'positions' && <BossPositions />}
      {tab === 'talent' && <BossTalent />}
      {tab === 'conversations' && <BossConversations />}
      {tab === 'reviews' && <BossReviews />}
      {tab === 'receipts' && <BossReceipts />}
    </div>
  );
}

function BossPositions() {
  const queryClient = useQueryClient();
  const positionsQuery = useQuery({ queryKey: queryKeys.bossPositions, queryFn: ({ signal }) => api.listBossPositions(signal) });
  const runsQuery = useQuery({ queryKey: queryKeys.bossSyncRuns, queryFn: ({ signal }) => api.listBossJobSyncRuns(signal) });
  const [selectedRun, setSelectedRun] = useState<string>();
  const runQuery = useQuery({ queryKey: ['boss', 'sync-run', selectedRun], queryFn: ({ signal }) => api.getBossJobSyncRun(selectedRun!, signal), enabled: Boolean(selectedRun) });
  const syncMutation = useMutation({ mutationFn: (bossJobIds?: string[]) => api.submitTask('boss-job-sync', { platform: 'boss', includeClosed: true, bossJobIds }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tasks }) });
  const refresh = () => void Promise.all([positionsQuery.refetch(), runsQuery.refetch()]);
  return (
    <>
      {(positionsQuery.error || runsQuery.error) && <ErrorState error={positionsQuery.error ?? runsQuery.error} onRetry={refresh} />}
      <Section title="职位快照" description="按稳定 Boss Job ID 展示，同名职位不会合并。" actions={<><button className="primary-button" type="button" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate(undefined)}><RefreshCw size={16} />同步全部职位和 JD</button><IconButton label="刷新本地记录" onClick={refresh} /></>}>
        {positionsQuery.isLoading && <LoadingState />}
        <div className="table-wrap"><table><thead><tr><th>职位</th><th>Boss Job ID</th><th>状态</th><th>本地 jobKey</th><th>最后同步</th><th>JD Hash</th><th></th></tr></thead><tbody>{positionsQuery.data?.positions.map((position) => <tr key={position.bossJobId}><td><strong>{position.name}</strong><small>{position.location ?? '-'}</small></td><td className="mono">{position.bossJobId}</td><td><StatusPill status={position.status === 'open' ? 'ok' : position.status === 'closed' ? 'neutral' : 'warning'} label={position.status} /></td><td className="mono">{position.jobKey ?? '-'}</td><td>{formatDate(position.syncedAt)}</td><td className="mono">{position.sourceHash?.slice(0, 14) ?? '-'}</td><td><button className="text-link" type="button" onClick={() => syncMutation.mutate([position.bossJobId])}>重新同步</button></td></tr>)}</tbody></table></div>
        {!positionsQuery.isLoading && !positionsQuery.data?.positions.length && <EmptyState title="还没有 Boss 职位快照" description="运行一次职位同步后，持久化快照会显示在这里。" />}
        {syncMutation.data && <SuccessNotice>同步任务已创建：{syncMutation.data.taskId}</SuccessNotice>}{syncMutation.error && <ErrorState error={syncMutation.error} />}
      </Section>
      <div className="split-layout">
        <Section title="同步历史" description={`${runsQuery.data?.runs.length ?? 0} 次`}><div className="compact-list">{runsQuery.data?.runs.map((run) => <button className={`compact-item clickable-row${selectedRun === run.runId ? ' selected' : ''}`} type="button" key={run.runId} onClick={() => setSelectedRun(run.runId)}><StatusPill status={run.failed ? 'failed' : 'succeeded'} label={run.failed ? `${run.failed} 失败` : '成功'} /><div><strong>{formatDate(run.syncedAt)}</strong><small>新增 {run.created} · 更新 {run.updated} · 未变化 {run.unchanged}</small></div></button>)}</div>{!runsQuery.data?.runs.length && <EmptyState title="暂无同步历史" />}</Section>
        <Section title="同步明细">{runQuery.isLoading && <LoadingState />}{runQuery.data ? <BossSyncRunDetail run={runQuery.data} /> : <EmptyState title="选择一条同步历史" />}</Section>
      </div>
    </>
  );
}

function BossSyncRunDetail({ run }: { run: BossJobSyncRun & { runId: string; artifact: ArtifactDescriptor } }) {
  return <div className="page-stack"><ArtifactButton artifact={run.artifact} /><div className="detail-grid"><div className="detail-cell"><span>创建</span><strong>{run.created}</strong></div><div className="detail-cell"><span>更新</span><strong>{run.updated}</strong></div><div className="detail-cell"><span>未变化</span><strong>{run.unchanged}</strong></div><div className="detail-cell"><span>失败</span><strong>{run.failed}</strong></div></div><div className="table-wrap"><table><thead><tr><th>职位</th><th>ID</th><th>jobKey</th><th>结果</th><th>错误</th></tr></thead><tbody>{run.items.map((item) => <tr key={item.bossJobId}><td>{item.name}</td><td className="mono">{item.bossJobId}</td><td>{item.jobKey ?? '-'}</td><td><StatusPill status={item.outcome === 'failed' ? 'failed' : item.outcome === 'unchanged' ? 'neutral' : 'succeeded'} label={item.outcome} /></td><td>{item.error ?? '-'}</td></tr>)}</tbody></table></div></div>;
}

function BossTalent() {
  const [source, setSource] = useState<'recommend' | 'deep-search'>('recommend');
  const [bossJobId, setBossJobId] = useState('');
  const [expectedJobName, setExpectedJobName] = useState('');
  const [core, setCore] = useState('');
  const [bonus, setBonus] = useState('');
  const [result, setResult] = useState<BossTalentSearchResult>();
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [greetIntentId, setGreetIntentId] = useState(() => crypto.randomUUID());
  const readMutation = useTaskMutation<BossTalentSearchResult>((task) => setResult(task.output as BossTalentSearchResult));
  const matchMutation = useTaskMutation<BossTalentSearchResult>((task) => setResult(task.output as BossTalentSearchResult));
  const greetMutation = useTaskMutation();
  const input = (triggerMatch: boolean) => ({ platform: 'boss', source, bossJobId: bossJobId.trim() || undefined, expectedJobName: expectedJobName.trim() || undefined, coreRequirements: splitList(core), bonusRequirements: splitList(bonus), triggerMatch, confirmed: triggerMatch });
  const selectedCandidate = result?.candidates.find((candidate) => candidate.candidateId === selectedCandidateId);
  const canMatch = source === 'deep-search' && Boolean(result?.form?.matchButtonEnabled && (result.form.remainingMatchCount ?? 0) > 0 && splitList(core)?.length);
  useEffect(() => {
    setGreetIntentId(crypto.randomUUID());
  }, [selectedCandidateId]);
  return (
    <div className="three-column">
      <Section className="sticky-panel" title="发现条件" description="默认只读，不消耗匹配额度。"><div className="segmented"><button type="button" className={source === 'recommend' ? 'active' : ''} onClick={() => setSource('recommend')}>推荐牛人</button><button type="button" className={source === 'deep-search' ? 'active' : ''} onClick={() => setSource('deep-search')}>深度搜索</button></div><div className="form-grid"><label className="wide"><span>Boss Job ID</span><input value={bossJobId} onChange={(event) => setBossJobId(event.target.value)} /></label><label className="wide"><span>预期职位名</span><input value={expectedJobName} onChange={(event) => setExpectedJobName(event.target.value)} /></label>{source === 'deep-search' && <><label className="wide"><span>核心要求（逗号分隔）</span><textarea value={core} onChange={(event) => setCore(event.target.value)} /></label><label className="wide"><span>加分要求</span><textarea value={bonus} onChange={(event) => setBonus(event.target.value)} /></label></>}</div><div className="form-actions"><button className="secondary-button" type="button" disabled={readMutation.pending} onClick={() => readMutation.submit('boss-talent-search', input(false))}><Search size={16} />只读查看</button>{source === 'deep-search' && <SafetyDialog trigger={<button className="primary-button" type="button" disabled={!canMatch}>立即匹配</button>} title="确认消耗立即匹配额度" description="该操作会在 Boss 平台执行匹配，最多返回最新 20 位候选人。" tone="warning" facts={[{ label: '职位', value: expectedJobName || result?.form?.jobName || '-' }, { label: 'Boss Job ID', value: bossJobId || '-' }, { label: '核心要求', value: splitList(core)?.join('、') || '-' }, { label: '剩余额度', value: result?.form?.remainingMatchCount ?? '-' }]} confirmLabel="确认立即匹配" busy={matchMutation.pending} onConfirm={() => matchMutation.submit('boss-talent-search', input(true))} />}</div>{readMutation.error && <ErrorState error={readMutation.error} />}{matchMutation.error && <ErrorState error={matchMutation.error} />}</Section>
      <Section title="候选人" description={result ? `${result.candidates.length} 位 · ${result.matched ? '已执行匹配' : '只读结果'}` : '等待读取'}>{readMutation.pending && <LoadingState label="Boss 只读任务执行中" />}<div className="card-list">{result?.candidates.map((candidate) => <button className={`candidate-card clickable-row${selectedCandidateId === candidate.candidateId ? ' selected' : ''}`} type="button" key={candidate.candidateId} onClick={() => setSelectedCandidateId(candidate.candidateId)}><div className="candidate-meta"><StatusPill status={candidate.contactState === 'continue-chat' ? 'ok' : 'neutral'} label={candidate.contactState} /><span className="mono">{candidate.candidateId}</span></div><h3>{candidate.name ?? '未命名候选人'}</h3><p>{candidate.summary ?? candidate.workSummary ?? '-'}</p>{candidate.recommendationReason && <small>{candidate.recommendationReason}</small>}</button>)}</div>{result && result.candidates.length === 0 && <EmptyState title="当前没有候选人" />}{!result && !readMutation.pending && <EmptyState title="先执行只读查看" />}</Section>
      <Section className="sticky-panel" title="候选人操作">{selectedCandidate ? <><div className="detail-grid"><div className="detail-cell"><span>姓名</span><strong>{selectedCandidate.name ?? '-'}</strong></div><div className="detail-cell"><span>Candidate ID</span><strong className="mono">{selectedCandidate.candidateId}</strong></div><div className="detail-cell"><span>联系状态</span><strong>{selectedCandidate.contactState}</strong></div><div className="detail-cell"><span>职位</span><strong>{expectedJobName || result?.form?.jobName || '-'}</strong></div></div><SafetyDialog trigger={<button className="danger-button" type="button" disabled={selectedCandidate.contactState === 'continue-chat'}><Send size={16} />单人打招呼</button>} title="确认联系候选人" description="提交前会在 Boss 页面再次核验 candidate ID、姓名和职位。" facts={[{ label: '候选人', value: selectedCandidate.name ?? '-' }, { label: 'Candidate ID', value: selectedCandidate.candidateId }, { label: '职位', value: expectedJobName || result?.form?.jobName || '-' }, { label: 'Intent ID', value: <span className="mono">{greetIntentId}</span> }]} confirmLabel="确认打招呼" busy={greetMutation.pending} onConfirm={() => greetMutation.submit('boss-greet', { platform: 'boss', source, candidateId: selectedCandidate.candidateId, expectedCandidateName: selectedCandidate.name, expectedJobName: expectedJobName || result?.form?.jobName, bossJobId: bossJobId || undefined, confirmed: true, intentId: greetIntentId })} />{greetMutation.task && <TaskResultNotice task={greetMutation.task} />}{greetMutation.error && <ErrorState error={greetMutation.error} />}</> : <EmptyState title="选择一位候选人" description="只有稳定 candidate ID 的结果可执行后续操作。" />}</Section>
    </div>
  );
}

function BossConversations() {
  const [listTaskId, setListTaskId] = useState<string>();
  const [detailTaskId, setDetailTaskId] = useState<string>();
  const [mutationTaskId, setMutationTaskId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [action, setAction] = useState<BossChatOperation>('send-text');
  const [text, setText] = useState('');
  const [remark, setRemark] = useState('');
  const [intentId, setIntentId] = useState(() => crypto.randomUUID());
  const submitMutation = useMutation({ mutationFn: ({ action: nextAction, body }: { action: BossChatOperation; body: Record<string, unknown> }) => api.submitTask('boss-chat-operation', { platform: 'boss', action: nextAction, ...body }) });
  const listTask = useTask(listTaskId);
  const detailTask = useTask(detailTaskId);
  const mutationTask = useTask(mutationTaskId);
  const listOutput = listTask.data?.output as BossChatOperationResult | undefined;
  const detailOutput = detailTask.data?.output as BossChatOperationResult | undefined;
  const conversations = listOutput?.conversations ?? [];
  const selected = conversations.find((item) => item.conversationId === selectedId);
  useEffect(() => {
    setIntentId(crypto.randomUUID());
  }, [selectedId, action]);
  useEffect(() => {
    if (mutationTask.data?.status === 'succeeded') setIntentId(crypto.randomUUID());
  }, [mutationTask.data?.status, mutationTask.data?.taskId]);
  const readList = () => { submitMutation.mutate({ action: 'list-conversations', body: { unreadOnly: true } }, { onSuccess: (task) => setListTaskId(task.taskId) }); };
  const readConversation = (conversationId: string) => { const target = conversations.find((item) => item.conversationId === conversationId); setSelectedId(conversationId); submitMutation.mutate({ action: 'read-history', body: { conversationId, expectedCandidateName: target?.candidateName, expectedJobName: target?.jobName } }, { onSuccess: (task) => setDetailTaskId(task.taskId) }); };
  const mutateConversation = () => {
    if (!selected) return;
    submitMutation.mutate({ action, body: { conversationId: selected.conversationId, expectedCandidateName: selected.candidateName, expectedJobName: selected.jobName, text: action === 'send-text' ? text : undefined, remark: action === 'remark' ? remark : undefined, intentId, confirmed: true } }, { onSuccess: (task) => setMutationTaskId(task.taskId) });
  };
  return (
    <div className="three-column">
      <Section className="sticky-panel" title="会话列表" description="先快照未读列表，再按 exact conversation ID 打开。" actions={<button className="secondary-button" type="button" disabled={submitMutation.isPending} onClick={readList}><RefreshCw size={15} />只读刷新</button>}>
        {listTask.loading && <LoadingState label="读取 Boss 未读会话" />}{listTask.error && <ErrorState error={listTask.error} />}
        <div className="task-list">{conversations.map((conversation) => <button className={`task-item${selectedId === conversation.conversationId ? ' active' : ''}`} type="button" key={conversation.conversationId} onClick={() => readConversation(conversation.conversationId)}><StatusPill status={conversation.unreadCount ? 'warning' : 'neutral'} label={`${conversation.unreadCount} 未读`} /><div className="task-item-content"><strong>{conversation.candidateName ?? conversation.conversationId}</strong><span>{conversation.jobName}</span><small className="mono">{conversation.conversationId}</small></div></button>)}</div>
        {!listTask.loading && conversations.length === 0 && <EmptyState title="暂无会话快照" description="点击“只读刷新”创建一次安全读取任务。" />}
      </Section>
      <Section title={selected?.candidateName ?? '会话详情'} description={selected ? `${selected.jobName} · ${selected.conversationId}` : '选择一个精确会话'}>
        {detailTask.loading && <LoadingState label="读取会话历史" />}{detailTask.error && <ErrorState error={detailTask.error} />}
        <div className="message-list">{detailOutput?.messages?.map((message, index) => <article className={`message ${message.sender === 'recruiter' ? 'recruiter' : ''}`} key={`${message.messageId ?? index}`}><small>{message.sender} · {formatDate(message.sentAt)}</small><p>{message.content}</p></article>)}</div>
        {selected && !detailTask.loading && !detailOutput?.messages?.length && <EmptyState title="当前未读取到消息" />}
        {!selected && <EmptyState title="选择一个会话" />}
      </Section>
      <Section className="sticky-panel" title="受控操作" description="通用发送不会覆盖 Boss 中已有草稿。">
        {!selected && <EmptyState title="先选择会话" />}
        {selected && <><div className="detail-cell"><span>目标身份</span><strong>{selected.candidateName ?? '-'} · {selected.jobName}</strong><small className="mono">{selected.conversationId}</small></div><label><span>操作</span><select value={action} onChange={(event) => setAction(event.target.value as BossChatOperation)}><option value="send-text">发送文本</option><option value="remark">设置备注</option><option value="mark-not-fit">标记不合适</option><option value="request-attachment-resume">索要附件简历</option><option value="accept-attachment-resume">接收附件简历</option><option value="exchange-phone">交换电话</option><option value="exchange-wechat">交换微信</option></select></label>{action === 'send-text' && <label><span>发送文本</span><textarea value={text} onChange={(event) => setText(event.target.value)} /></label>}{action === 'remark' && <label><span>备注</span><input value={remark} onChange={(event) => setRemark(event.target.value)} /></label>}<SafetyDialog trigger={<button className="danger-button" type="button" disabled={submitMutation.isPending || (action === 'send-text' && !text.trim()) || (action === 'remark' && !remark.trim())}><MessageSquareText size={16} />核对并提交</button>} title="确认 Boss 会话变更" description="操作成功后会保存 intent ID 回执；相同 intent 重试不会重复外部动作。" facts={[{ label: '候选人', value: selected.candidateName ?? '-' }, { label: '职位', value: selected.jobName }, { label: '会话 ID', value: selected.conversationId }, { label: '操作', value: action }, { label: 'Intent ID', value: <span className="mono">{intentId}</span> }]} confirmLabel="确认执行变更" busy={submitMutation.isPending} onConfirm={mutateConversation} />{mutationTask.loading && <LoadingState label="变更任务执行中" />}{mutationTask.data && <TaskResultNotice task={mutationTask.data} />}{mutationTask.error && <ErrorState error={mutationTask.error} />}</>}
      </Section>
    </div>
  );
}

function BossReviews() {
  const listQuery = useQuery({ queryKey: queryKeys.bossReviews, queryFn: ({ signal }) => api.listBossChatReviews(signal) });
  const [selected, setSelected] = useState<string>();
  const detailQuery = useQuery({ queryKey: ['boss', 'review', selected], queryFn: ({ signal }) => api.getBossChatReview(selected!, signal), enabled: Boolean(selected) });
  return <div className="split-layout"><Section title="审核运行" description="仅展示已持久化的 review run。">{listQuery.isLoading && <LoadingState />}<div className="compact-list">{listQuery.data?.runs.map((run) => <button className={`compact-item clickable-row${selected === run.runId ? ' selected' : ''}`} type="button" key={run.runId} onClick={() => setSelected(run.runId)}><StatusPill status={run.failedConversations ? 'failed' : 'succeeded'} label={run.failedConversations ? `${run.failedConversations} 失败` : '完成'} /><div><strong>{formatDate(run.reviewedAt)}</strong><small>审核 {run.reviewedConversations} · 匹配 {run.matchedCandidates} · 跟进 {run.followUpConversations ?? 0}</small></div></button>)}</div>{!listQuery.data?.runs.length && <EmptyState title="暂无自动沟通审核记录" />}</Section><Section title="审核明细">{detailQuery.isLoading && <LoadingState />}{detailQuery.data ? <div className="page-stack"><ArtifactButton artifact={detailQuery.data.artifact} /><div className="detail-grid"><div className="detail-cell"><span>未读</span><strong>{detailQuery.data.unreadConversations}</strong></div><div className="detail-cell"><span>审核</span><strong>{detailQuery.data.reviewedConversations}</strong></div><div className="detail-cell"><span>匹配</span><strong>{detailQuery.data.matchedCandidates}</strong></div><div className="detail-cell"><span>失败</span><strong>{detailQuery.data.failedConversations}</strong></div></div><div className="table-wrap"><table><thead><tr><th>候选人</th><th>职位</th><th>状态</th><th>转发</th><th>联系</th><th>错误</th></tr></thead><tbody>{detailQuery.data.items.map((item) => <tr key={item.conversationId}><td>{item.candidateName ?? item.candidateId ?? '-'}</td><td>{item.jobName}<small>{item.bossJobId ?? ''}</small></td><td>{item.status}</td><td>{item.forwarded ? '是' : '否'}</td><td>{item.chatMessageSent || item.phoneExchangeRequested ? '是' : '否'}</td><td>{item.error ?? '-'}</td></tr>)}</tbody></table></div></div> : <EmptyState title="选择一条审核运行" />}</Section></div>;
}

function BossReceipts() {
  const query = useQuery({ queryKey: queryKeys.bossReceipts, queryFn: ({ signal }) => api.listBossChatReceipts(signal) });
  const [search, setSearch] = useState('');
  const receipts = useMemo(() => (query.data?.receipts ?? []).filter((item) => !search.trim() || [item.input.intentId, item.input.conversationId, item.input.expectedCandidateName, item.result.candidateName, item.input.action].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase())), [query.data, search]);
  return <Section title="幂等操作回执" description="相同 intent ID 重试会返回已有结果，不会重复外部动作。" actions={<label><span>搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="intent / 候选人 / 会话" /></label>}>{query.isLoading && <LoadingState />}{query.error && <ErrorState error={query.error} />}<div className="table-wrap"><table><thead><tr><th>完成时间</th><th>Intent ID</th><th>操作</th><th>候选人</th><th>会话</th><th>状态</th><th>工件</th></tr></thead><tbody>{receipts.map((receipt) => <tr key={receipt.receiptId}><td>{formatDate(receipt.result.completedAt)}</td><td className="mono">{receipt.input.intentId}</td><td>{receipt.input.action}</td><td>{receipt.result.candidateName ?? receipt.input.expectedCandidateName ?? '-'}</td><td className="mono">{receipt.input.conversationId ?? '-'}</td><td><StatusPill status={receipt.result.changed ? 'succeeded' : 'neutral'} label={receipt.result.changed ? '已变更' : '无变更'} /></td><td><ArtifactButton artifact={receipt.artifact} /></td></tr>)}</tbody></table></div>{!query.isLoading && receipts.length === 0 && <EmptyState title="暂无回执" />}</Section>;
}

function useTask(taskId?: string) {
  const query = useQuery({ queryKey: queryKeys.task(taskId ?? ''), queryFn: ({ signal }) => api.getTask(taskId!, signal), enabled: Boolean(taskId), refetchInterval: (query) => query.state.data?.status === 'queued' || query.state.data?.status === 'running' ? 2_000 : false });
  return { data: query.data, loading: query.isLoading || query.data?.status === 'queued' || query.data?.status === 'running', error: query.error };
}

function useTaskMutation<T = unknown>(onComplete?: (task: TaskDetail) => void) {
  const [taskId, setTaskId] = useState<string>();
  const submitMutation = useMutation({ mutationFn: ({ kind, body }: { kind: 'boss-talent-search' | 'boss-greet'; body: Record<string, unknown> }) => api.submitTask(kind, body), onSuccess: (task) => setTaskId(task.taskId) });
  const task = useTask(taskId);
  const completed = task.data?.status === 'succeeded' ? task.data : undefined;
  const completedId = completed?.taskId;
  const [handledId, setHandledId] = useState<string>();
  useEffect(() => {
    if (!completed || !completedId || completedId === handledId) return;
    setHandledId(completedId);
    onComplete?.(completed);
  }, [completed, completedId, handledId, onComplete]);
  return { submit: (kind: 'boss-talent-search' | 'boss-greet', body: Record<string, unknown>) => submitMutation.mutate({ kind, body }), pending: submitMutation.isPending || task.loading, task: task.data, error: submitMutation.error ?? task.error, output: completed?.output as T | undefined };
}

function TaskResultNotice({ task }: { task: TaskDetail }) {
  if (task.status === 'failed') return <ErrorState error={new Error(task.error ?? 'Boss 任务失败')} />;
  if (task.status === 'queued' || task.status === 'running') return <LoadingState label="Boss 任务执行中" />;
  const output = task.output as BossChatOperationResult | undefined;
  return <SuccessNotice><Sparkles size={17} />任务完成{output?.receiptPath ? `，回执已保存：${output.receiptPath}` : ''}</SuccessNotice>;
}

function splitList(value: string): string[] | undefined {
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  return result.length ? result : undefined;
}
