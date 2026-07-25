import { AlertTriangle, CheckCircle2, CircleDashed, Inbox, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TaskStatus } from '../api/contracts';

export const PLATFORM_LABELS = {
  all: '全部主平台',
  '51job': '51job',
  liepin: '猎聘',
  zhilian: '智联',
  boss: 'Boss 直聘',
} as const;

export const TASK_LABELS = {
  'resume-capture': '简历抓取',
  batch: '批量任务',
  'search-subscription': '搜索订阅',
  'boss-auto-chat': 'Boss 自动沟通',
  'boss-talent-search': 'Boss 人才发现',
  'boss-greet': 'Boss 单人打招呼',
  'boss-chat-operation': 'Boss 会话操作',
  'boss-job-sync': 'Boss 职位同步',
  'login-refresh': '登录刷新',
  'rag-ops': 'RAG 运维',
} as const;

export function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

export function formatCompactDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Section({ title, description, actions, children, className = '' }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`surface ${className}`.trim()}>
      {(title || actions) && (
        <div className="section-heading">
          <div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children?: ReactNode; disabled?: boolean }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children ?? <RefreshCw size={17} />}</button>;
}

export function StatusPill({ status, label }: { status?: TaskStatus | 'ok' | 'warning' | 'neutral'; label?: string }) {
  const labels: Record<string, string> = {
    queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', ok: '正常', warning: '注意', neutral: '未知',
  };
  return <span className={`status-pill status-${status ?? 'neutral'}`}>{label ?? labels[status ?? 'neutral']}</span>;
}

export function LoadingState({ label = '正在读取真实数据' }: { label?: string }) {
  return <div className="state-block"><Loader2 className="spin" size={20} /><span>{label}</span></div>;
}

export function EmptyState({ title = '暂无数据', description }: { title?: string; description?: string }) {
  return <div className="state-block state-empty"><Inbox size={22} /><strong>{title}</strong>{description && <span>{description}</span>}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-banner" role="alert">
      <AlertTriangle size={19} />
      <div><strong>读取失败</strong><span>{message}</span></div>
      {onRetry && <button type="button" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function Metric({ label, value, note, tone = 'default', icon }: { label: string; value: ReactNode; note?: string; tone?: 'default' | 'info' | 'success' | 'warning' | 'danger'; icon?: ReactNode }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{icon ?? <CircleDashed size={16} />}<span>{label}</span></div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function JsonViewer({ value }: { value: unknown }) {
  return <pre className="json-viewer">{JSON.stringify(value, null, 2)}</pre>;
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return <div className="success-banner"><CheckCircle2 size={18} />{children}</div>;
}
