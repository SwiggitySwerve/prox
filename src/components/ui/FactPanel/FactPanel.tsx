import { Children, createContext, isValidElement, useContext, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDollarSign } from '../icons';
import styles from './FactPanel.module.scss';

/** Set by a compact FactPanel: label and value share a line, and a long note is one line. */
const CompactContext = createContext(false);

export type FactState =
  | { state: 'known'; value: ReactNode; aside?: ReactNode }
  | { state: 'estimated'; value: ReactNode; basis: ReactNode }
  | { state: 'notReported'; reason: ReactNode }
  | { state: 'notApplicable'; reason: ReactNode };
export function Fact(
  props: FactState & {
    label: ReactNode;
    tone?: 'overdue';
    variant?: 'code';
    /** A muted line under the fact, in any state. */
    note?: string;
    /** Keep the note to one line, cut short with the whole text as its tooltip. */
    clampNote?: boolean;
  }
) {
  const { t } = useTranslation();
  const compact = useContext(CompactContext);
  const basis =
    props.state === 'estimated' ? `${t('quota_pool.billing_estimated')} · ${props.basis}` : '';
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
      {/* A compact card keeps the estimate's basis to one line; its tooltip has all of it. */}
      {props.state === 'estimated' &&
        (compact ? (
          <dd className={`${styles.detail} ${styles.clamp}`} title={basis}>
            {basis}
          </dd>
        ) : (
          <dd className={styles.detail}>
            {t('quota_pool.billing_estimated')} · {props.basis}
          </dd>
        ))}
      {props.state === 'notReported' && <dd className={styles.detail}>{props.reason}</dd>}
      {props.state === 'known' && props.aside && <dd className={styles.detail}>{props.aside}</dd>}
      {props.note &&
        (props.clampNote ? (
          <dd className={`${styles.detail} ${styles.clamp}`} title={props.note}>
            {props.note}
          </dd>
        ) : (
          <dd className={styles.detail}>{props.note}</dd>
        ))}
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
  const noteEl = note && (
    <p id={id} role="status" className={styles.note}>
      {note}
    </p>
  );
  return (
    <section className={styles.section} data-tone={tone} data-action={action ? '' : undefined}>
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
      {/* With an action, its status or reason sits right under the button, not below the facts. */}
      {action && noteEl}
      <dl>{children}</dl>
      {!action && noteEl}
    </section>
  );
}
export function FactPanel({
  children,
  compact = false,
}: {
  children: ReactNode;
  /** A tight layout for a card: each label and value on one line, smaller gaps. */
  compact?: boolean;
}) {
  // Sections may be supplied by a provider component. A context-free CSS guard also
  // prevents any later accent section from gaining a second surface.
  const accents = Children.toArray(children).filter(
    (child) => isValidElement<FactSectionProps>(child) && child.props.tone === 'accent'
  );
  if (accents.length > 1) throw new Error('FactPanel allows at most one accent section');
  return (
    <div className={styles.container} data-compact={compact || undefined}>
      <div className={styles.panel}>
        <CompactContext.Provider value={compact}>{children}</CompactContext.Provider>
      </div>
    </div>
  );
}
