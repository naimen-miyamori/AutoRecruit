import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { AssistantPage } from '../features/assistant/AssistantPage';
import { AutomationPage } from '../features/automation/AutomationPage';
import { BossPage } from '../features/boss/BossPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { CandidateDetailPage } from '../features/jobs/CandidateDetailPage';
import { JobDetailPage } from '../features/jobs/JobDetailPage';
import { JobsPage } from '../features/jobs/JobsPage';
import { KnowledgePage } from '../features/knowledge/KnowledgePage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { SearchConditionSetsPage } from '../features/searchConditionSets/SearchConditionSetsPage';
import { TasksPage } from '../features/tasks/TasksPage';
import { NewTaskPage } from '../features/run/NewTaskPage';
import { TalentMappingsPage } from '../features/talentMapping/TalentMappingsPage';
import { EmptyState } from '../components/ui';

function NotFoundPage() {
  return <EmptyState title="页面不存在" description="返回控制台或从左侧导航继续。" />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <NotFoundPage />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tasks/:taskId', element: <TasksPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'jobs/:platform/:jobKey', element: <JobDetailPage /> },
      { path: 'jobs/:platform/:jobKey/candidates/:candidateId', element: <CandidateDetailPage /> },
      { path: 'talent-mappings', element: <TalentMappingsPage /> },
      { path: 'talent-mappings/:mappingKey', element: <TalentMappingsPage /> },
      { path: 'boss/*', element: <BossPage /> },
      { path: 'automation', element: <AutomationPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
      { path: 'search-condition-sets', element: <SearchConditionSetsPage /> },
      { path: 'assistant', element: <AssistantPage /> },
      { path: 'run', element: <NewTaskPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
