import type { PoolProviderId } from '@/domain/quotaPool/types';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import styles from './QuotaPoolPage.module.scss';

export function PoolProviderMark({ provider }: { provider: PoolProviderId }) {
  return <img className={styles.providerMark} src={PROVIDER_LOGOS[provider].src} alt="" />;
}
