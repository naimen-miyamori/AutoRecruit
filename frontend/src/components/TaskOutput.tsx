import { ArtifactButton } from './ArtifactButton';
import { EmptyState, JsonViewer, Section, StatusPill } from './ui';
import type { ArtifactDescriptor } from '../api/contracts';

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
