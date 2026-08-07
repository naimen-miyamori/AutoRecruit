import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Send, ShieldAlert, WandSparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssistantDraft, AssistantMessage } from '../../api/contracts';
import { api } from '../../api/client';
import { modelConfigForRequest } from '../../api/model-settings';
import { ErrorState, PageHeader, Section, SuccessNotice, formatDate } from '../../components/ui';

const quickActions = ['只读列出 Boss 未读会话', '同步 Boss 全部职位和 JD', '查看 Boss 深度搜索条件，不立即匹配', '检查 RAG 运维指标'];
const derivedDraftFields = new Set([
  'searchSource',
  'modeId',
  'kind',
  'modeLabel',
  'effectSummary',
  'argvPreview',
  'bossSavedSearchReference',
  'bossCaptureSettingsSnapshot',
  'bossCaptureTaskSnapshot',
]);

export function AssistantPage() {
  const [messages, setMessages] = useState<AssistantMessage[]>([{ role: 'assistant', content: '描述要执行的招聘操作。我只会生成结构化草稿，确认前不会执行。', createdAt: new Date().toISOString() }]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<AssistantDraft>();
  const [riskAccepted, setRiskAccepted] = useState(false);
  const draftGeneration = useRef(0);
  const chatMutation = useMutation({
    mutationFn: ({ nextMessages, currentDraft }: { nextMessages: AssistantMessage[]; currentDraft?: AssistantDraft; generation: number }) => api.chatWithAssistant({ messages: nextMessages, draft: currentDraft, modelConfig: modelConfigForRequest() }),
    onSuccess: (response, variables) => {
      if (variables.generation !== draftGeneration.current) return;
      setMessages((current) => [...current, response.message]);
      setDraft(response.draft);
      setRiskAccepted(false);
    },
  });
  const validateMutation = useMutation({
    mutationFn: ({ candidate }: { candidate: AssistantDraft; generation: number }) => api.validateAssistantDraft(candidate),
    onSuccess: (response, variables) => {
      if (variables.generation !== draftGeneration.current) return;
      setDraft(response.draft);
      setMessages((current) => [...current, response.message]);
      setRiskAccepted(false);
    },
  });
  const confirmMutation = useMutation({ mutationFn: ({ candidate, accepted }: { candidate: AssistantDraft; accepted: boolean }) => api.confirmAssistantDraft(candidate, accepted) });
  const submit = (text = input) => {
    const content = text.trim();
    if (!content || chatMutation.isPending || confirmMutation.isPending) return;
    const message: AssistantMessage = { role: 'user', content, createdAt: new Date().toISOString() };
    const currentDraft = draft;
    const generation = draftGeneration.current + 1;
    draftGeneration.current = generation;
    setMessages((current) => [...current, message]);
    setInput('');
    setDraft(undefined);
    setRiskAccepted(false);
    validateMutation.reset();
    confirmMutation.reset();
    chatMutation.mutate({ nextMessages: [...messages, message], currentDraft, generation });
  };
  const updateDraft = (field: string, value: unknown) => {
    if (!draft) return;
    if (derivedDraftFields.has(field)) return;
    draftGeneration.current += 1;
    setDraft({ ...draft, input: { ...draft.input, [field]: value } } as AssistantDraft);
    setRiskAccepted(false);
  };
  const hasRisk = draft?.warnings.some((warning) => warning.startsWith('风险：')) ?? false;
  const canConfirm = Boolean(draft && !chatMutation.isPending && draft.missingFields.length === 0 && (!hasRisk || riskAccepted));

  return (
    <div className="page-stack">
      <PageHeader eyebrow="ASSISTANT" title="智能助手" description="自然语言只用于生成受限草稿；最终执行仍由 normalizer 和 TaskQueue 决定。" />
      <div className="two-column">
        <Section title="对话" description="API key 只随本次草稿请求发送。"><div className="assistant-quick">{quickActions.map((item) => <button className="ghost-button" type="button" key={item} disabled={chatMutation.isPending || confirmMutation.isPending} onClick={() => submit(item)}>{item}</button>)}</div><div className="assistant-messages">{messages.map((message, index) => <article className={`assistant-message ${message.role}`} key={`${message.createdAt}-${index}`}><small>{message.role === 'user' ? '你' : '助手'} · {formatDate(message.createdAt)}</small><p>{message.content}</p></article>)}</div><div className="assistant-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：只读列出 Boss 未读会话" /><button className="primary-button" type="button" disabled={chatMutation.isPending || confirmMutation.isPending} onClick={() => submit()}><Send size={16} />发送</button></div>{chatMutation.error && <ErrorState error={chatMutation.error} />}</Section>
        <Section title="结构化草稿" description={draft ? `${draft.modeLabel ?? '任务'} · 服务端会按该业务模式重新校验` : '等待助手生成草稿'}>
          {!draft && <div className="assistant-placeholder"><WandSparkles size={28} /><span>草稿将在这里显示并允许人工核对。</span></div>}
          {draft && <><div className="boss-banner"><WandSparkles size={18} /><span>{draft.effectSummary ?? '服务端将重新校验此草稿后再确认执行。'}</span></div><div className="form-grid">{Object.entries(draft.input).filter(([field]) => !derivedDraftFields.has(field)).map(([field, value]) => <DraftField field={field} value={value} onChange={updateDraft} key={field} />)}</div>{draft.missingFields.length > 0 && <div className="error-banner">缺少字段：{draft.missingFields.join('、')}</div>}{draft.warnings.map((warning) => <div className="boss-banner" key={warning}><ShieldAlert size={18} /><span>{warning}</span></div>)}{hasRisk && <label className="checkbox-field"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />我已核对目标身份和外部操作风险</label>}<div className="form-actions"><button className="secondary-button" type="button" disabled={validateMutation.isPending} onClick={() => validateMutation.mutate({ candidate: draft, generation: draftGeneration.current })}>重新校验</button><button className="primary-button" type="button" disabled={!canConfirm || confirmMutation.isPending} onClick={() => confirmMutation.mutate({ candidate: draft, accepted: riskAccepted })}><CheckCircle2 size={16} />确认</button></div></>}
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
