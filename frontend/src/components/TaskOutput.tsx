import { ArtifactButton } from './ArtifactButton';
import { EmptyState, JsonViewer, Section, StatusPill } from './ui';
import type { ArtifactDescriptor } from '../api/contracts';
import { Link } from 'react-router-dom';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function count(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const parsed = Number(value[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function rejectionDeliveryTargetsFromInput(value: unknown): Array<{ recipientEmail: string; ccEmails: string[] }> {
  if (!isRecord(value)) return [];
  if (typeof value.bossSecondaryEmail === 'string' && value.bossSecondaryEmail.trim()) {
    return [{ recipientEmail: value.bossSecondaryEmail, ccEmails: stringList(value.bossSecondaryCc) }];
  }
  const settings = isRecord(value.bossCaptureSettingsSnapshot) ? value.bossCaptureSettingsSnapshot : undefined;
  const task = isRecord(value.bossCaptureTaskSnapshot) ? value.bossCaptureTaskSnapshot : undefined;
  const deliveryAndScreening = task && isRecord(task.deliveryAndScreening) ? task.deliveryAndScreening : undefined;
  const screening = settings && isRecord(settings.screening)
    ? settings.screening
    : deliveryAndScreening && isRecord(deliveryAndScreening.screening)
      ? deliveryAndScreening.screening
      : undefined;
  const delivery = screening && isRecord(screening.secondaryDelivery) ? screening.secondaryDelivery : undefined;
  return delivery && typeof delivery.recipientEmail === 'string' && delivery.recipientEmail.trim()
    ? [{ recipientEmail: delivery.recipientEmail, ccEmails: stringList(delivery.ccEmails) }]
    : [];
}

function artifact(value: unknown): ArtifactDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.artifactId !== 'string' || typeof value.label !== 'string' || typeof value.fileName !== 'string' || typeof value.contentType !== 'string') {
    return undefined;
  }
  return {
    artifactId: value.artifactId,
    label: value.label,
    fileName: value.fileName,
    contentType: value.contentType,
  };
}

export function TaskOutput({ kind, input, output }: { kind: string; input?: unknown; output: unknown }) {
  if (!output) return <EmptyState title="任务尚无输出" description="运行完成后会在这里显示结构化结果。" />;
  if (Array.isArray(output)) {
    return <div className="card-list">{output.map((item, index) => <TaskOutput key={index} kind={kind} input={input} output={item} />)}</div>;
  }
  if (!isRecord(output)) return <JsonViewer value={output} />;

  if (isRecord(output.summary) && 'totalCandidates' in output.summary && ('platform' in output || 'keyword' in output)) {
    return (
      <div className="page-stack">
        <div className="receipt-box"><strong>{text(output.platform)}{output.keyword ? ` · ${text(output.keyword)}` : ''}</strong></div>
        <TaskOutput kind={kind} input={input} output={output.summary} />
      </div>
    );
  }

  if (output.mode === 'search-subscription' && output.status === 'failed') {
    const results = array(output.results);
    return (
      <div className="page-stack">
        <div className="stale-banner"><strong>订阅管理在 {text(output.stoppedPlatform)} 停止</strong><span>{text(output.error)}</span></div>
        <div className="detail-grid">
          <div className="detail-cell"><span>已完成平台</span><strong>{Array.isArray(output.completedPlatforms) ? output.completedPlatforms.map(text).join(' → ') || '-' : '-'}</strong></div>
          <div className="detail-cell"><span>停止平台</span><strong>{text(output.stoppedPlatform)}</strong></div>
        </div>
        {results.length > 0 && <div className="card-list">{results.map((item, index) => <TaskOutput key={`${text(item.platform)}-${index}`} kind={kind} output={item} />)}</div>}
      </div>
    );
  }

  if ('resultTotal' in output && 'saveRequested' in output && 'conditionStatusCounts' in output) {
    const savedSearch = isRecord(output.savedSearch) ? output.savedSearch : undefined;
    const identity = savedSearch && isRecord(savedSearch.conditionIdentity) ? savedSearch.conditionIdentity : undefined;
    return (
      <div className="page-stack">
        <div className="detail-grid">
          <div className="detail-cell"><span>平台 / 关键词</span><strong>{text(output.platform)} · {text(output.keyword)}</strong></div>
          <div className="detail-cell"><span>搜索结果</span><strong>{text(output.resultTotal)}（{text(output.resultTotalSource)}）</strong></div>
          <div className="detail-cell"><span>条件应用</span><strong>{output.allConditionsApplied === true ? '全部成功' : '存在跳过或失败'}</strong></div>
          <div className="detail-cell"><span>保存结果</span><strong>{output.saveRequested === true ? `${output.saved === true ? '已保存' : '未保存'} · ${text(output.saveOutcome)}` : '未请求保存'}</strong></div>
          <div className="detail-cell"><span>排序策略</span><strong>{text(output.sortPolicy)}</strong></div>
        </div>
        {savedSearch && <div className="receipt-box"><strong>Boss 原生订阅引用</strong><div>名称：{text(savedSearch.name)} · 页面关键词：{text(savedSearch.expectedKeyword)}</div><div>职位范围：{text(identity?.jobScope)} · Native ID：{text(savedSearch.nativeId)}</div><div className="mono">条件指纹：{text(savedSearch.conditionFingerprint)}</div></div>}
        {output.saveRequested === true && <div className="security-note">这是平台原生订阅保存/改名结果；本任务不会抓取候选、打开详情、写 seen/评分/报告或发送邮件。</div>}
      </div>
    );
  }

  if (kind === 'talent-mapping') {
    const hasGaps = output.status === 'completed-with-gaps'
      || Number(output.failedProfiles ?? 0) > 0
      || Number(output.cappedSlices ?? 0) > 0;
    return (
      <div className="page-stack">
        {hasGaps && <div className="stale-banner"><strong>运行完成但存在覆盖缺口</strong><span>受限切片或详情失败已保留在覆盖视图中，不代表全量 Mapping。</span></div>}
        <div className="detail-grid">
          <div className="detail-cell"><span>项目</span><strong>{text(output.mappingKey)}</strong></div>
          <div className="detail-cell"><span>阶段 / 状态</span><strong>{text(output.stage)} · {text(output.status)}</strong></div>
          <div className="detail-cell"><span>卡片观察</span><strong>{text(output.observedCards)}</strong></div>
          <div className="detail-cell"><span>平台唯一档案</span><strong>{text(output.uniquePlatformProfiles)}</strong></div>
          <div className="detail-cell"><span>详情成功</span><strong>{text(output.enrichedProfiles)}</strong></div>
          <div className="detail-cell"><span>详情失败</span><strong>{text(output.failedProfiles)}</strong></div>
          <div className="detail-cell"><span>受限切片</span><strong>{text(output.cappedSlices)}</strong></div>
          <div className="detail-cell"><span>详情副作用</span><strong>{output.detailOpenSideEffect === 'may-mark-viewed' ? '可能标记已查看' : '无详情打开'}</strong></div>
        </div>
        {typeof output.mappingKey === 'string' && <Link className="primary-button" to={`/talent-mappings/${encodeURIComponent(output.mappingKey)}`}>打开人才地图项目</Link>}
        <div className="detail-grid"><div className="detail-cell"><span>Run ID</span><strong className="mono">{text(output.runId)}</strong></div><div className="detail-cell"><span>导出目录</span><strong className="mono">{text(output.exportDir)}</strong></div><div className="detail-cell"><span>运行记录</span><strong className="mono">{text(output.runPath)}</strong></div></div>
      </div>
    );
  }

  if (kind === 'talent-mapping-classification') {
    return (
      <div className="page-stack">
        <div className="stale-banner"><strong>模型输出仅为待审核建议</strong><span>建议不会自动修改人才档案；只有人工接受后才会填补待归类字段。</span></div>
        <div className="detail-grid">
          <div className="detail-cell"><span>项目</span><strong>{text(output.mappingKey)}</strong></div>
          <div className="detail-cell"><span>模型</span><strong>{text(output.model)}</strong></div>
          <div className="detail-cell"><span>检查候选</span><strong>{text(output.consideredCandidates)}</strong></div>
          <div className="detail-cell"><span>新建议</span><strong>{text(output.generatedSuggestions)}</strong></div>
          <div className="detail-cell"><span>无有效建议</span><strong>{text(output.skippedCandidates)}</strong></div>
        </div>
        {typeof output.mappingKey === 'string' && <Link className="primary-button" to={`/talent-mappings/${encodeURIComponent(output.mappingKey)}`}>进入分类审核</Link>}
      </div>
    );
  }

  if ('totalCandidates' in output && (isRecord(output.bossRouting) || isRecord(output.rejectionEmails))) {
    const routing = isRecord(output.bossRouting) ? output.bossRouting : undefined;
    const forwarding = routing && isRecord(routing.forwardingStatusCounts) ? routing.forwardingStatusCounts : undefined;
    const pendingScoreCount = routing && Array.isArray(routing.pendingScoreCandidateIds)
      ? routing.pendingScoreCandidateIds.length
      : 0;
    const scoreFailureCounts = routing && isRecord(routing.scoreFailureStatusCounts)
      ? routing.scoreFailureStatusCounts
      : undefined;
    const scoreFailureSummary = scoreFailureCounts
      ? Object.entries(scoreFailureCounts).map(([status, value]) => `${status}: ${text(value)}`).join('；')
      : '';
    const rejection = routing && isRecord(routing.rejectionEmailStatusCounts)
      ? routing.rejectionEmailStatusCounts
      : isRecord(output.rejectionEmails) ? output.rejectionEmails : undefined;
    const rejectionSummary = isRecord(output.rejectionEmails) ? output.rejectionEmails : undefined;
    const summaryTargets = array(rejectionSummary?.deliveryTargets)
      .filter((target) => typeof target.recipientEmail === 'string' && target.recipientEmail.trim())
      .map((target) => ({ recipientEmail: String(target.recipientEmail), ccEmails: stringList(target.ccEmails) }));
    const rejectionTargets = summaryTargets.length > 0 ? summaryTargets : rejectionDeliveryTargetsFromInput(input);
    const rejectionRecipients = [...new Set(rejectionTargets.map((target) => target.recipientEmail))];
    const rejectionCc = [...new Set(rejectionTargets.flatMap((target) => target.ccEmails))];
    const uncertain = count(rejection, 'uncertain');
    const sending = count(rejection, 'sending');
    const pending = count(rejection, 'pending');
    const retryableFailed = count(rejection, 'retryableFailed') + count(rejection, 'retryable-failed');
    const superseded = count(rejection, 'superseded');
    const failedCandidateIds = stringList(rejectionSummary?.failedCandidateIds);
    const eligible = count(rejectionSummary, 'eligible') || (Array.isArray(routing?.rejectedCandidateIds) ? routing.rejectedCandidateIds.length : 0);
    const sent = rejectionSummary ? count(rejectionSummary, 'sent') : count(rejection, 'sent');
    return (
      <div className="page-stack">
        <div className="detail-grid">
          <div className="detail-cell"><span>岗位</span><strong>{text(output.jobKey)}</strong></div>
          <div className="detail-cell"><span>候选人总数</span><strong>{text(output.totalCandidates)}</strong></div>
          <div className="detail-cell"><span>已抓取</span><strong>{text(output.capturedCandidates ?? output.newCandidates)}</strong></div>
          <div className="detail-cell"><span>已评分</span><strong>{text(output.scoredCandidates)}</strong></div>
          <div className="detail-cell"><span>失败</span><strong>{text(output.failedCandidates)}</strong></div>
        </div>
        {routing && <Section title="Boss 评分后分流" description="页面转发与否定简历邮件是两个独立交付通道。">
          <div className="detail-grid">
            <div className="detail-cell"><span>明确符合</span><strong>{Array.isArray(routing.qualifiedCandidateIds) ? routing.qualifiedCandidateIds.length : 0}</strong></div>
            <div className="detail-cell"><span>需复核</span><strong>{Array.isArray(routing.reviewCandidateIds) ? routing.reviewCandidateIds.length : 0}</strong></div>
            <div className="detail-cell"><span>明确否定</span><strong>{Array.isArray(routing.rejectedCandidateIds) ? routing.rejectedCandidateIds.length : 0}</strong></div>
            <div className="detail-cell"><span>评分未决</span><strong>{pendingScoreCount}</strong></div>
            <div className="detail-cell"><span>Boss 转发已发送</span><strong>{count(forwarding, 'sent')}</strong></div>
            <div className="detail-cell"><span>Boss 转发待处理</span><strong>{count(forwarding, 'pending') + count(forwarding, 'retryable-failed') + count(forwarding, 'uncertain')}</strong></div>
          </div>
          {pendingScoreCount > 0 && <div className="stale-banner"><strong>存在尚未形成分流决定的评分</strong><span>{scoreFailureSummary || '失败阶段已记录在运行结果中'}；这些候选人不会转发或发送否定邮件，将保留 pending-score 等待重试。</span></div>}
        </Section>}
        {(rejection || rejectionSummary) && <Section title="否定简历邮件" description="每位明确否定候选人对应一封邮件；同候选人重跑不会自动重发已发送或结果不确定的邮件。">
          <div className="detail-grid">
            <div className="detail-cell"><span>副收件人</span><strong>{rejectionRecipients.length > 0 ? rejectionRecipients.join('、') : '已固化在任务快照'}</strong></div>
            <div className="detail-cell"><span>邮件抄送</span><strong>{rejectionCc.length > 0 ? rejectionCc.join('、') : '无 / 已固化在任务快照'}</strong></div>
            <div className="detail-cell"><span>应发份数</span><strong>{eligible}</strong></div>
            <div className="detail-cell"><span>已发送</span><strong>{sent}</strong></div>
            <div className="detail-cell"><span>待处理 / 可重试</span><strong>{pending + retryableFailed}</strong></div>
            <div className="detail-cell"><span>发送中断待核对</span><strong>{sending}</strong></div>
            <div className="detail-cell"><span>结果不确定</span><strong>{uncertain}</strong></div>
            <div className="detail-cell"><span>已终止 / 废弃</span><strong>{superseded}</strong></div>
          </div>
          {sending > 0 && <div className="stale-banner"><strong>存在停留在 sending 的否定邮件</strong><span>请勿人工重发；下一次 Boss 运行会将其转为 uncertain 后要求人工核对。</span></div>}
          {uncertain > 0 && <div className="stale-banner"><strong>存在结果不确定的否定邮件</strong><span>系统不会自动重发；请先人工核对 SMTP 收件箱和投递日志。</span></div>}
          {failedCandidateIds.length > 0 && <div className="receipt-box"><strong>需要人工处理的候选人</strong><div className="mono">{failedCandidateIds.join('、')}</div></div>}
        </Section>}
        {typeof output.resultPath === 'string' && <div className="receipt-box"><strong>运行结果</strong><div className="mono">{output.resultPath}</div></div>}
      </div>
    );
  }

  if (kind === 'boss-talent-search') {
    const candidates = array(output.candidates);
    return (
      <div className="page-stack">
        <div className="detail-grid">
          <div className="detail-cell"><span>来源</span><strong>{text(output.source)}</strong></div>
          <div className="detail-cell"><span>是否执行匹配</span><strong>{output.matched === true ? '已执行' : '只读'}</strong></div>
          <div className="detail-cell"><span>候选人数</span><strong>{candidates.length}</strong></div>
          <div className="detail-cell"><span>剩余额度</span><strong>{text(isRecord(output.form) ? output.form.remainingMatchCount : undefined)}</strong></div>
        </div>
        <div className="card-list">
          {candidates.map((candidate) => (
            <article className="candidate-card" key={text(candidate.candidateId)}>
              <div className="candidate-meta"><StatusPill status="neutral" label={text(candidate.contactState)} /><span className="mono">{text(candidate.candidateId)}</span></div>
              <h3>{text(candidate.name)}</h3>
              <p>{text(candidate.summary ?? candidate.workSummary)}</p>
              {typeof candidate.recommendationReason === 'string' && <small>{candidate.recommendationReason}</small>}
            </article>
          ))}
        </div>
      </div>
    );
  }

  if (kind === 'boss-chat-operation') {
    const conversations = array(output.conversations);
    const messages = array(output.messages);
    return (
      <div className="page-stack">
        <div className="detail-grid">
          <div className="detail-cell"><span>操作</span><strong>{text(output.action)}</strong></div>
          <div className="detail-cell"><span>会话 ID</span><strong className="mono">{text(output.conversationId)}</strong></div>
          <div className="detail-cell"><span>候选人</span><strong>{text(output.candidateName)}</strong></div>
          <div className="detail-cell"><span>外部状态变更</span><strong>{output.changed === true ? '是' : '否'}</strong></div>
        </div>
        {conversations.length > 0 && <Section title="会话列表"><div className="compact-list">{conversations.map((item) => <div className="compact-item" key={text(item.conversationId)}><div><strong>{text(item.candidateName)}</strong><small>{text(item.jobName)} · {text(item.conversationId)}</small></div><StatusPill status={Number(item.unreadCount) > 0 ? 'warning' : 'neutral'} label={`${text(item.unreadCount)} 未读`} /></div>)}</div></Section>}
        {messages.length > 0 && <Section title="消息"><div className="message-list">{messages.map((message, index) => <article className={`message ${message.sender === 'recruiter' ? 'recruiter' : ''}`} key={`${text(message.messageId)}-${index}`}><small>{text(message.sender)} · {text(message.sentAt)}</small><p>{text(message.content)}</p></article>)}</div></Section>}
        {typeof output.receiptPath === 'string' && <div className="receipt-box"><strong>幂等回执已保存</strong><div className="mono">{output.receiptPath}</div></div>}
      </div>
    );
  }

  if (kind === 'boss-job-sync') {
    const items = array(output.items);
    return (
      <div className="page-stack">
        <div className="detail-grid">
          {['created', 'updated', 'unchanged', 'failed'].map((field) => <div className="detail-cell" key={field}><span>{field}</span><strong>{text(output[field])}</strong></div>)}
        </div>
        <div className="table-wrap"><table><thead><tr><th>职位</th><th>Boss Job ID</th><th>本地岗位</th><th>结果</th><th>错误</th></tr></thead><tbody>{items.map((item) => <tr key={text(item.bossJobId)}><td>{text(item.name)}</td><td className="mono">{text(item.bossJobId)}</td><td>{text(item.jobKey)}</td><td><StatusPill status={item.outcome === 'failed' ? 'failed' : item.outcome === 'unchanged' ? 'neutral' : 'succeeded'} label={text(item.outcome)} /></td><td>{text(item.error)}</td></tr>)}</tbody></table></div>
      </div>
    );
  }

  if (kind === 'boss-greet') {
    return <div className="detail-grid"><div className="detail-cell"><span>候选人</span><strong>{text(output.candidateName ?? output.candidateId)}</strong></div><div className="detail-cell"><span>职位</span><strong>{text(output.jobName)}</strong></div><div className="detail-cell"><span>打招呼</span><strong>{output.greeted === true ? '已完成' : '未执行'}</strong></div><div className="detail-cell"><span>此前已联系</span><strong>{output.alreadyContacted === true ? '是' : '否'}</strong></div></div>;
  }

  if (kind === 'boss-auto-chat') {
    const items = array(output.items);
    return <div className="page-stack"><div className="detail-grid">{['unreadConversations', 'reviewedConversations', 'matchedCandidates', 'failedConversations'].map((field) => <div className="detail-cell" key={field}><span>{field}</span><strong>{text(output[field])}</strong></div>)}</div>{items.length > 0 && <div className="table-wrap"><table><thead><tr><th>候选人</th><th>职位</th><th>分支</th><th>状态</th><th>转发</th><th>错误</th></tr></thead><tbody>{items.map((item) => <tr key={text(item.conversationId)}><td>{text(item.candidateName)}</td><td>{text(item.jobName)}</td><td>{text(isRecord(item.previousChat) ? item.previousChat.kind : '-')}</td><td>{text(item.status)}</td><td>{item.forwarded === true ? '是' : '否'}</td><td>{text(item.error)}</td></tr>)}</tbody></table></div>}</div>;
  }

  if ('answered' in output || 'answer' in output) {
    return <div className={output.answered === false ? 'answer no-answer' : 'answer'}><h3>{output.answered === false ? '未找到可信答案' : '回答'}</h3><p>{text(output.answer)}</p><small>置信度：{text(output.confidence)} · {text(output.noAnswerReason)}</small></div>;
  }

  const outputArtifact = artifact(output.artifact);
  if (outputArtifact) {
    return <ArtifactButton artifact={outputArtifact} />;
  }

  return <JsonViewer value={output} />;
}
