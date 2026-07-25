import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Send, ShieldAlert, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssistantDraft, AssistantMessage } from '../../api/contracts';
import { api } from '../../api/client';
import { modelConfigForRequest } from '../../api/model-settings';
import { ErrorState, PageHeader, Section, SuccessNotice, formatDate } from '../../components/ui';

const quickActions = ['只读列出 Boss 未读会话', '同步 Boss 全部职位和 JD', '查看 Boss 深度搜索条件，不立即匹配', '检查 RAG 运维指标'];

export function AssistantPage() {
  const [messages, setMessages] = useState<AssistantMessage[]>([{ role: 'assistant', content: '描述要执行的招聘操作。我只会生成结构化草稿，确认前不会执行。', createdAt: new Date().toISOString() }]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<AssistantDraft>();
  const [riskAccepted, setRiskAccepted] = useState(false);
  const chatMutation = useMutation({
    mutationFn: (nextMessages: AssistantMessage[]) => api.chatWithAssistant({ messages: nextMessages, draft, modelConfig: modelConfigForRequest() }),
    onSuccess: (response) => { setMessages((current) => [...current, response.message]); if (response.draft) setDraft(response.draft); setRiskAccepted(false); },
  });
  const validateMutation = useMutation({ mutationFn: () => api.validateAssistantDraft(draft!), onSuccess: (response) => { if (response.draft) setDraft(response.draft); setMessages((current) => [...current, response.message]); setRiskAccepted(false); } });
  const confirmMutation = useMutation({ mutationFn: () => api.confirmAssistantDraft(draft!, riskAccepted) });
  const submit = (text = input) => {
    const content = text.trim();
    if (!content) return;
    const message: AssistantMessage = { role: 'user', content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, message]);
    setInput('');
    chatMutation.mutate([...messages, message]);
  };
  const updateDraft = (field: string, value: unknown) => {
    if (!draft) return;
    setDraft({ ...draft, input: { ...draft.input, [field]: value } } as AssistantDraft);
    setRiskAccepted(false);
  };
  const hasRisk = draft?.warnings.some((warning) => warning.startsWith('风险：')) ?? false;
  const canConfirm = Boolean(draft && draft.missingFields.length === 0 && (!hasRisk || riskAccepted));

  return (
    <div className="page-stack">
      <PageHeader eyebrow="ASSISTANT" title="智能助手" description="自然语言只用于生成受限草稿；最终执行仍由 normalizer 和 TaskQueue 决定。" />
      <div className="two-column">
        <Section title="对话" description="API key 只随本次草稿请求发送。"><div className="assistant-quick">{quickActions.map((item) => <button className="ghost-button" type="button" key={item} onClick={() => submit(item)}>{item}</button>)}</div><div className="assistant-messages">{messages.map((message, index) => <article className={`assistant-message ${message.role}`} key={`${message.createdAt}-${index}`}><small>{message.role === 'user' ? '你' : '助手'} · {formatDate(message.createdAt)}</small><p>{message.content}</p></article>)}</div><div className="assistant-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：只读列出 Boss 未读会话" /><button className="primary-button" type="button" disabled={chatMutation.isPending} onClick={() => submit()}><Send size={16} />发送</button></div>{chatMutation.error && <ErrorState error={chatMutation.error} />}</Section>
        <Section title="结构化草稿" description={draft ? `类型：${draft.kind}` : '等待助手生成草稿'}>
          {!draft && <div className="assistant-placeholder"><WandSparkles size={28} /><span>草稿将在这里显示并允许人工核对。</span></div>}
          {draft && <><div className="form-grid">{Object.entries(draft.input).map(([field, value]) => <DraftField field={field} value={value} onChange={updateDraft} key={field} />)}</div>{draft.missingFields.length > 0 && <div className="error-banner">缺少字段：{draft.missingFields.join('、')}</div>}{draft.warnings.map((warning) => <div className="boss-banner" key={warning}><ShieldAlert size={18} /><span>{warning}</span></div>)}{hasRisk && <label className="checkbox-field"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />我已核对目标身份和外部操作风险</label>}<div className="form-actions"><button className="secondary-button" type="button" disabled={validateMutation.isPending} onClick={() => validateMutation.mutate()}>重新校验</button><button className="primary-button" type="button" disabled={!canConfirm || confirmMutation.isPending} onClick={() => confirmMutation.mutate()}><CheckCircle2 size={16} />确认</button></div></>}
          {validateMutation.error && <ErrorState error={validateMutation.error} />}{confirmMutation.error && <ErrorState error={confirmMutation.error} />}
          {confirmMutation.data && (confirmMutation.data.kind === 'rag-answer' ? <div className="answer"><p>{String(confirmMutation.data.answer.answer ?? '')}</p></div> : <SuccessNotice>任务已创建：<Link className="text-link" to={`/tasks/${encodeURIComponent(confirmMutation.data.task.taskId)}`}>{confirmMutation.data.task.taskId}</Link></SuccessNotice>)}
        </Section>
      </div>
    </div>
  );
}

function DraftField({ field, value, onChange }: { field: string; value: unknown; onChange: (field: string, value: unknown) => void }) {
  if (typeof value === 'boolean') return <label className="checkbox-field"><input type="checkbox" checked={value} onChange={(event) => onChange(field, event.target.checked)} />{field}</label>;
  if (typeof value === 'number') return <label><span>{field}</span><input type="number" value={value} onChange={(event) => onChange(field, Number(event.target.value))} /></label>;
  if (Array.isArray(value)) return <label><span>{field}</span><input value={value.join(', ')} onChange={(event) => onChange(field, event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} /></label>;
  const isLong = ['jd', 'text', 'question', 'remark'].includes(field);
  return <label className={isLong ? 'wide' : ''}><span>{field}</span>{isLong ? <textarea value={value === undefined ? '' : String(value)} onChange={(event) => onChange(field, event.target.value)} /> : <input value={value === undefined ? '' : String(value)} onChange={(event) => onChange(field, event.target.value)} />}</label>;
}
