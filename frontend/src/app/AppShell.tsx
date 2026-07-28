import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Clock3,
  Command,
  Database,
  LayoutDashboard,
  ListChecks,
  Map,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const NAV: Array<{ to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }> = [
  { to: '/', label: '控制台', icon: LayoutDashboard, exact: true },
  { to: '/tasks', label: '任务中心', icon: ListChecks },
  { to: '/jobs', label: '岗位与人才', icon: BriefcaseBusiness },
  { to: '/talent-mappings', label: '人才地图', icon: Map },
  { to: '/boss', label: 'Boss 工作台', icon: ShieldCheck },
  { to: '/automation', label: '自动化', icon: Clock3 },
  { to: '/knowledge', label: '知识与运营', icon: Database },
  { to: '/assistant', label: '智能助手', icon: Bot },
] as const;

const PAGE_NAMES: Array<[string, string]> = [
  ['/tasks', '任务中心'], ['/jobs', '岗位与人才'], ['/talent-mappings', '人才地图'], ['/boss', 'Boss 工作台'], ['/automation', '自动化'],
  ['/knowledge', '知识与运营'], ['/assistant', '智能助手'], ['/settings', '设置'], ['/run', '新建任务'], ['/', '控制台'],
];

export function AppShell() {
  const location = useLocation();
  const pageName = PAGE_NAMES.find(([prefix]) => prefix === '/' ? location.pathname === '/' : location.pathname.startsWith(prefix))?.[1] ?? '页面';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink className="brand" to="/" aria-label="AutoRecruit 控制台">
          <span className="brand-mark">AR</span>
          <span><strong>AutoRecruit</strong><small>招聘运营客户端</small></span>
        </NavLink>
        <nav className="primary-nav" aria-label="主导航">
          {NAV.map(({ to, label, icon: Icon, exact }) => (
            <NavLink key={to} to={to} end={exact} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <Icon size={18} /><span>{label}</span><ChevronRight className="nav-caret" size={14} />
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink to="/run" className="new-task-link"><Command size={17} /><span>新建任务</span><kbd>N</kbd></NavLink>
          <NavLink to="/settings" className="nav-link"><Settings2 size={18} /><span>设置</span></NavLink>
        </div>
      </aside>
      <main className="main-area">
        <div className="app-statusbar">
          <span><Activity size={14} /> 本地运营控制台</span>
          <span className="statusbar-page">{pageName}</span>
        </div>
        <div className="page-container"><Outlet /></div>
      </main>
    </div>
  );
}
