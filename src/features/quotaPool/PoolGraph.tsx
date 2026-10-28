import type { ReactNode } from 'react';
import styles from './QuotaPoolPage.module.scss';

/** Plot sizing belongs to its card; corner controls can sit beside the card's other actions. */
export function PoolGraph({
  title,
  id,
  minimized,
  children,
}: {
  title: string;
  id: string;
  minimized: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={styles.forecast} aria-label={title} data-minimized={minimized}>
      {children}
    </section>
  );
}
