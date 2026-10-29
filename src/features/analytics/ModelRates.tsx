import { useTranslation } from 'react-i18next';
import type { AnalyticsResponse } from '@/domain/analytics/types';
import { AnalyticsChart } from './AnalyticsChart';
import { analyticsNumber, analyticsTime } from './format';
import styles from './AnalyticsPage.module.scss';

export function ModelRates({ data }: { data: AnalyticsResponse }) {
  const { t, i18n } = useTranslation();
  const money = (n: number | null) => analyticsNumber(n, i18n.language, true);
  return (
    <>
      <p className={styles.notice}>{t('analytics.rate_note')}</p>
      <AnalyticsChart
        title={t('analytics.input_rate_chart')}
        currency
        data={data.rates.map((r, index) => ({
          key: String(index),
          label: `${r.instance_label} · ${r.provider} · ${r.id}`,
          value: r.input_per_million,
        }))}
      />
      <section className={styles.panel}>
        <h2>{t('analytics.tabs.rates')}</h2>
        {data.catalog_sources
          ?.filter((source) => source.state === 'unavailable')
          .map((source) => (
            <p className={styles.notice} key={source.instance_id}>
              {t('analytics.catalog_unavailable', { source: source.label })}
            </p>
          ))}
        {data.rates.length === 0 ? (
          <p>{t('analytics.empty_rates')}</p>
        ) : (
          <div
            className={styles.tableScroll}
            role="region"
            tabIndex={0}
            aria-label={t('analytics.tabs.rates')}
          >
            <table className={styles.rates}>
              <caption>{t('analytics.rate_unit')}</caption>
              <thead>
                <tr>
                  {[
                    'source_provider',
                    'model',
                    'registration',
                    'billing_model',
                    'input',
                    'output',
                    'cache_read',
                    'cache_write',
                    'rate_details',
                  ].map((key) => (
                    <th key={key} scope="col">
                      {t(`analytics.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rates.map((rate, index) => (
                  <tr key={`${rate.instance_id}:${rate.provider}:${rate.id}:${index}`}>
                    <td>
                      {rate.instance_label}
                      <small>{rate.provider}</small>
                    </td>
                    <th scope="row">{rate.id}</th>
                    <td>
                      {t(`analytics.${rate.registered ? 'registered' : 'observed'}`)}
                      <small>{t(`analytics.price_status.${rate.status}`)}</small>
                    </td>
                    <td>{rate.matched_model ?? t('analytics.not_reported')}</td>
                    <td>{money(rate.input_per_million)}</td>
                    <td>{money(rate.output_per_million)}</td>
                    <td>{money(rate.cache_read_per_million)}</td>
                    <td>{money(rate.cache_write_per_million)}</td>
                    <td>
                      <details>
                        <summary>{t('analytics.rate_details')}</summary>
                        <p>
                          {t('analytics.rate_source')}: {rate.source || t('analytics.not_reported')}
                        </p>
                        <p>
                          {t('analytics.updated')}:{' '}
                          {rate.updated_at_ms === null
                            ? t('analytics.not_reported')
                            : `${analyticsTime(rate.updated_at_ms, i18n.language)} UTC`}
                        </p>
                        <h4>{t('analytics.context_tiers')}</h4>
                        {rate.context_tiers.length === 0 ? (
                          <p>{t('analytics.not_reported')}</p>
                        ) : (
                          <ul>
                            {rate.context_tiers.map((tier, i) => (
                              <li key={i}>
                                {t('analytics.above_input', { count: tier.above_input_tokens })}:{' '}
                                {money(tier.input_per_million)} / {money(tier.output_per_million)}
                              </li>
                            ))}
                          </ul>
                        )}
                        <h4>{t('analytics.service_tiers')}</h4>
                        {rate.service_tiers.length === 0 ? (
                          <p>{t('analytics.not_reported')}</p>
                        ) : (
                          <ul>
                            {rate.service_tiers.map((tier, i) => (
                              <li key={i}>
                                {tier.name}: {money(tier.input_per_million)} /{' '}
                                {money(tier.output_per_million)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
