import { Navigate, useLocation } from 'react-router-dom';
import { legacyModelsTarget, type ModelsTab } from './matrixView';

export function LegacyModelsRedirect({ tab }: { tab: ModelsTab }) {
  const location = useLocation();
  // Keep navigation state: it may pin the originating source session.
  return <Navigate to={legacyModelsTarget(location.search, tab)} replace state={location.state} />;
}
