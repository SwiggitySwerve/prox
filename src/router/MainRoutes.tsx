import { AuthFileEditorBoundary } from '@/components/sources/AuthFileEditorBoundary';
import { SelectedSourceBoundary } from '@/components/sources/SelectedSourceBoundary';
import { Navigate, useRoutes, type Location } from 'react-router-dom';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ProvidersWorkbenchPage } from '@/features/providers/ProvidersWorkbenchPage';
import { AuthFilesPage } from '@/features/authFiles/AuthFilesPage';
import { AuthFilesOAuthExcludedEditPage } from '@/pages/AuthFilesOAuthExcludedEditPage';
import { AuthFilesOAuthModelAliasEditPage } from '@/pages/AuthFilesOAuthModelAliasEditPage';
import { OAuthPage } from '@/features/oauth/OAuthPage';
import { QuotaPage } from '@/features/quota/QuotaPage';
import { QuotaPoolPage } from '@/features/quotaPool/QuotaPoolPage';
import { PluginResourcePage } from '@/features/plugins/PluginResourcePage';
import { PluginsPage } from '@/features/plugins/PluginsPage';
import { PluginStorePage } from '@/features/plugins/PluginStorePage';
import { ConfigPage } from '@/features/config/ConfigPage';
import { LogsPage } from '@/features/logs/LogsPage';
import { SystemPage } from '@/pages/SystemPage';

const createMainRoutes = () => [
  { path: '/', element: <Navigate to="/quota" replace /> },
  { path: '/dashboard', element: <DashboardPage /> },
  { path: '/settings', element: <Navigate to="/config" replace /> },
  { path: '/api-keys', element: <Navigate to="/config" replace /> },
  { path: '/quick-start', element: <ProvidersWorkbenchPage fixedBrand="apikeyFun" /> },
  { path: '/quick-start/*', element: <Navigate to="/quick-start" replace /> },
  { path: '/ai-providers', element: <ProvidersWorkbenchPage /> },
  { path: '/ai-providers/*', element: <Navigate to="/ai-providers" replace /> },
  { path: '/auth-files', element: <AuthFilesPage /> },
  {
    path: '/auth-files/oauth-excluded',
    element: (
      <AuthFileEditorBoundary>
        <AuthFilesOAuthExcludedEditPage />
      </AuthFileEditorBoundary>
    ),
  },
  {
    path: '/auth-files/oauth-model-alias',
    element: (
      <AuthFileEditorBoundary>
        <AuthFilesOAuthModelAliasEditPage />
      </AuthFileEditorBoundary>
    ),
  },
  {
    path: '/oauth',
    element: (
      <SelectedSourceBoundary>
        <OAuthPage />
      </SelectedSourceBoundary>
    ),
  },
  { path: '/quota', element: <QuotaPoolPage /> },
  { path: '/quota/accounts', element: <QuotaPage /> },
  { path: '/plugin-pages/:pluginId/:menuIndex', element: <PluginResourcePage /> },
  { path: '/plugins', element: <PluginsPage /> },
  { path: '/plugin-store', element: <PluginStorePage /> },
  { path: '/plugins/*', element: <Navigate to="/plugins" replace /> },
  {
    path: '/config',
    element: (
      <SelectedSourceBoundary>
        <ConfigPage />
      </SelectedSourceBoundary>
    ),
  },
  {
    path: '/logs',
    element: (
      <SelectedSourceBoundary>
        <LogsPage />
      </SelectedSourceBoundary>
    ),
  },
  {
    path: '/system',
    element: (
      <SelectedSourceBoundary>
        <SystemPage />
      </SelectedSourceBoundary>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function MainRoutes({ location }: { location?: Location }) {
  return useRoutes(createMainRoutes(), location);
}
