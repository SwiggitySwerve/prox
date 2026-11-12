import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { LoginShell, LoginSplash } from '@/pages/LoginSplash';

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  // Only a cold load with a saved sign-in restores here. restoreSession applies the full rules
  // (remember-password, a stored key); after a logout or 401 isLoggedIn is gone, so the user
  // goes straight to /login. Restoring in place keeps the requested page instead of bouncing
  // through /login and back.
  const [restoring, setRestoring] = useState(
    () => !isAuthenticated && localStorage.getItem('isLoggedIn') === 'true'
  );

  useEffect(() => {
    if (!restoring) return;
    let active = true;
    void restoreSession().finally(() => {
      if (active) setRestoring(false);
    });
    return () => {
      active = false;
    };
  }, [restoring, restoreSession]);

  if (restoring) {
    return (
      <LoginShell>
        <LoginSplash />
      </LoginShell>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
