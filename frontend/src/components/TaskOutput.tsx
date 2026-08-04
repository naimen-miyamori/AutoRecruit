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

export function TaskOutput({ kind, output }: { kind: string; output: unknown }) {
  if (!output) return <EmptyState title="任务尚无输出" description="运行完成后会在这里显示结构化结果。" />;
  if (Array.isArray(output)) {
    return <div className="card-list">{output.map((item, index) => <TaskOutput key={index} kind={kind} output={item} />)}</div>;
  }
  if (!isRecord(output)) return <JsonViewer value={output} />;

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
