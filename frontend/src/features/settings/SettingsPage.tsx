import { useMutation } from '@tanstack/react-query';
import { KeyRound, PlugZap, Save } from 'lucide-react';
import { useState } from 'react';
import type { ModelConfig } from '../../api/contracts';
import { api, getConsoleConnectionSettings, saveConsoleConnectionSettings } from '../../api/client';
import { loadModelConfig, saveModelConfig } from '../../api/model-settings';
import { ErrorState, PageHeader, Section, SuccessNotice } from '../../components/ui';

export function SettingsPage() {
  const [connection, setConnection] = useState(getConsoleConnectionSettings);
  const [model, setModel] = useState<ModelConfig>(loadModelConfig);
  const [saved, setSaved] = useState(false);
  const testMutation = useMutation({ mutationFn: () => api.health() });
  const save = () => { saveConsoleConnectionSettings(connection); saveModelConfig(model); setSaved(true); window.setTimeout(() => setSaved(false), 2500); };
  return (
    <div className="page-stack">
      <PageHeader eyebrow="SETTINGS" title="设置" description="控制台访问令牌与模型 API key 严格分离，且都不会进入任务记录。" actions={<button className="primary-button" type="button" onClick={save}><Save size={16} />保存当前浏览器设置</button>} />
      {saved && <SuccessNotice>设置已保存。控制台 token 和模型 key 仅保留在本次浏览器会话。</SuccessNotice>}
      <div className="two-column">
        <Section title="控制台连接" description="Bearer token 仅发送到本地控制台的 Authorization header。"><div className="form-grid"><label className="wide"><span>API 地址</span><input value={connection.apiBaseUrl} onChange={(event) => setConnection((current) => ({ ...current, apiBaseUrl: event.target.value }))} placeholder="/api" /></label><label className="wide"><span>控制台 Bearer token</span><input type="password" autoComplete="off" value={connection.token} onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))} /></label></div><div className="form-actions"><button className="secondary-button" type="button" onClick={() => { saveConsoleConnectionSettings(connection); testMutation.mutate(); }}><PlugZap size={16} />测试连接</button></div>{testMutation.data && <SuccessNotice>{testMutation.data.service} 连接正常</SuccessNotice>}{testMutation.error && <ErrorState error={testMutation.error} />}</Section>
        <Section title="请求级模型设置" description="只影响智能助手草稿和控制台 RAG 回答。"><div className="form-grid"><label className="wide"><span>OpenAI 兼容 Base URL</span><input value={model.baseUrl ?? ''} onChange={(event) => setModel((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="留空使用服务端设置" /></label><label><span>模型</span><input value={model.model ?? ''} onChange={(event) => setModel((current) => ({ ...current, model: event.target.value }))} /></label><label><span>模型 API key</span><input type="password" autoComplete="off" value={model.apiKey ?? ''} onChange={(event) => setModel((current) => ({ ...current, apiKey: event.target.value }))} placeholder="留空使用服务端 OPENAI_API_KEY" /></label></div><div className="security-note"><KeyRound size={18} /><span>模型 key 不进入 Authorization header，不写任务、草稿、日志或 localStorage。</span></div></Section>
      </div>
    </div>
  );
}
