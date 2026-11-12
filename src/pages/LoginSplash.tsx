import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '@/components/brand/BrandMark';
import styles from './LoginPage.module.scss';

/** The sign-in screen's frame: brand panel on the left, `children` in the right panel. */
export function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.container}>
      {/* 左侧品牌展示区 */}
      <div className={styles.brandPanel}>
        <div className={styles.brandContent}>
          <span className={styles.brandWord}>CLI</span>
          <span className={styles.brandWord}>PROXY</span>
          <span className={styles.brandWord}>API</span>
        </div>
      </div>

      {/* 右侧功能交互区 */}
      <div className={styles.formPanel}>{children}</div>
    </div>
  );
}

/** Shown while a saved session is restored, on /login and on a cold deep link alike. */
export function LoginSplash() {
  const { t } = useTranslation();
  return (
    <div className={styles.splashContent}>
      <span className={styles.splashLogo}>
        <BrandMark animated />
      </span>
      <h1 className={styles.splashTitle}>Prox</h1>
      <p className={styles.splashSubtitle}>{t('sidebar.subtitle')}</p>
      <div className={styles.splashLoader}>
        <div className={styles.splashLoaderBar} />
      </div>
    </div>
  );
}
