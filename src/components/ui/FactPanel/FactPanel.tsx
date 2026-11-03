import { Children, isValidElement, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDollarSign } from '../icons';
import styles from './FactPanel.module.scss';

export type FactState =
  | { state: 'known'; value: ReactNode; aside?: ReactNode }
  | { state: 'estimated'; value: ReactNode; basis: ReactNode }
  | { state: 'notReported'; reason: ReactNode }
  | { state: 'notApplicable'; reason: ReactNode };
export function Fact(props: FactState & { label: ReactNode; tone?: 'overdue'; variant?: 'code' }) {
  const { t } = useTranslation();
  return (
    <div className={styles.fact} data-tone={props.tone}>
      <dt>{props.label}</dt>
      <dd>
        {props.tone === 'overdue' && <IconDollarSign size={14} aria-hidden="true" />}
        <span
          className={
            [
              props.variant === 'code' ? styles.code : '',
              props.state === 'known' || props.state === 'estimated' ? styles.value : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
        >
          {props.state === 'known' || props.state === 'estimated'
            ? props.value
            : props.state === 'notReported'
              ? t('quota_pool.not_reported')
              : props.reason}
        </span>
      </dd>
      {/* The basis or reason is its own line under the value, so on phones it reads full width. */}
      {props.state === 'estimated' && (
        <dd className={styles.detail}>
          {t('quota_pool.billing_estimated')} · {props.basis}
        </dd>
      )}
      {props.state === 'notReported' && <dd className={styles.detail}>{props.reason}</dd>}
      {props.state === 'known' && props.aside && <dd className={styles.detail}>{props.aside}</dd>}
    </div>
  );
}
export type FactSectionProps = {
  /** Omit when the host already names the group (a sheet header, a disclosure label). */
  title?: ReactNode;
  tone?: 'accent';
  children: ReactNode;
} & (
  | { action?: undefined; note?: ReactNode }
  | {
      action: { label: ReactNode; context: string; disabled?: boolean; onClick: () => void };
      note: ReactNode;
    }
);
export function FactSection({ title, tone, children, action, note }: FactSectionProps) {
  const id = useId();
  return (
    <section className={styles.section} data-tone={tone}>
      {(title || action) && (
        <header>
          {title && <h4>{title}</h4>}
          {action && (
            <button
              type="button"
              disabled={action.disabled}
              onClick={action.onClick}
              aria-describedby={id}
            >
              {action.label}
              <span className={styles.srOnly}> {action.context}</span>
            </button>
          )}
        </header>
      )}
      <dl>{children}</dl>
      {note && (
        <p id={id} role="status" className={styles.note}>
          {note}
        </p>
      )}
    </section>
  );
}
export function FactPanel({ children }: { children: ReactNode }) {
  // Sections may be supplied by a provider component. A context-free CSS guard also
  // prevents any later accent section from gaining a second surface.
  const accents = Children.toArray(children).filter(
    (child) => isValidElement<FactSectionProps>(child) && child.props.tone === 'accent'
  );
  if (accents.length > 1) throw new Error('FactPanel allows at most one accent section');
  return (
    <div className={styles.container}>
      <div className={styles.panel}>{children}</div>
    </div>
  );
}
