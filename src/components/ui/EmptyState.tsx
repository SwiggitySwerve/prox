import type { ReactNode } from 'react';
import { IconInbox } from './icons';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Replaces the inbox, e.g. a warning for an error. */
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-content">
        <div className="empty-icon" aria-hidden="true">
          {icon ?? <IconInbox size={20} />}
        </div>
        <div>
          <div className="empty-title">{title}</div>
          {description && <div className="empty-desc">{description}</div>}
        </div>
      </div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
