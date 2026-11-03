import { Fact, FactPanel, FactSection } from '@/components/ui/FactPanel';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { IconCheck, IconX } from '@/components/ui/icons';
import { getProviderTotalStats, type ProviderRecentUsageMap } from '@/components/providers/utils';
import type { OpenAIProviderConfig } from '@/types';
import { maskApiKey } from '@/utils/format';
import {
  getSponsorProviderDefinition,
  isMultiProtocolSponsorBrand,
  sponsorProtocolI18nKey,
  sponsorProtocolUrl,
} from '../sponsorDefinitions';
import type { ProviderResource, SponsorProviderRaw } from '../types';
import styles from './forms/sharedForm.module.scss';

interface ResourceDetailViewProps {
  resource: ProviderResource;
  usageByProvider?: ProviderRecentUsageMap;
}

const sponsorProtocolEntryKey = (protocol: string): string => {
  if (protocol === 'claude') return 'anthropicEntries';
  if (protocol === 'codex') return 'codexEntries';
  return `${protocol}Entries`;
};

export function ResourceDetailView({ resource, usageByProvider }: ResourceDetailViewProps) {
  const { t } = useTranslation();

  if (isMultiProtocolSponsorBrand(resource.brand)) {
    const definition = getSponsorProviderDefinition(resource.brand);
    const raw = resource.raw as SponsorProviderRaw;
    const openaiKeyCount = raw.openai.reduce(
      (count, item) => count + (item.config.apiKeyEntries?.length ?? 0),
      0
    );
    const codexKeyCount = raw.codex.length;
    const geminiKeyCount = raw.gemini.length;
    const firstKey =
      raw.openai
        .flatMap((item) => item.config.apiKeyEntries ?? [])
        .find((entry) => entry.apiKey?.trim())?.apiKey ??
      raw.codex.find((item) => item.config.apiKey?.trim())?.config.apiKey ??
      raw.claude.find((item) => item.config.apiKey?.trim())?.config.apiKey ??
      raw.gemini.find((item) => item.config.apiKey?.trim())?.config.apiKey;
    const baseUrl = definition.resolveBaseUrl(
      raw.openai[0]?.config.baseUrl ??
        raw.codex[0]?.config.baseUrl ??
        raw.claude[0]?.config.baseUrl ??
        raw.gemini[0]?.config.baseUrl
    );
    const protocolUrls = definition.getProtocolUrls(baseUrl);
    const protocolCounts: Record<string, number> = {
      openai: openaiKeyCount,
      codex: codexKeyCount,
      claude: raw.claude.length,
      gemini: geminiKeyCount,
    };

    return (
      <div>
        <div className={styles.detailHeader}>
          <div className={styles.sectionTitle}>{resource.name ?? resource.identifier}</div>
          <p className={styles.sectionDesc}>
            {t('providersPage.sponsor.detailHint', { provider: definition.displayName })}
          </p>
        </div>

        <div className={styles.sponsorProtocolGrid}>
          {definition.protocols.map((protocol) => (
            <div key={protocol} className={styles.sponsorProtocolCard}>
              <span className={styles.sponsorProtocolName}>
                {t(`providersPage.sponsor.protocols.${sponsorProtocolI18nKey(protocol)}`)}
              </span>
              <span className={styles.sponsorProtocolUrl}>
                {sponsorProtocolUrl(protocolUrls, protocol)}
              </span>
            </div>
          ))}
        </div>

        <FactPanel>
          <FactSection title={t('account_details.title')}>
            <Fact
              label={t('providersPage.detail.fields.identifier')}
              state="known"
              variant="code"
              value={firstKey ? maskApiKey(firstKey) : resource.identifier}
            />
            <Fact
              label={t('providersPage.detail.fields.prefix')}
              state="known"
              value={resource.prefix ?? t('providersPage.status.none')}
            />
            {definition.protocols.map((protocol) => (
              <Fact
                key={protocol}
                label={t(`providersPage.sponsor.${sponsorProtocolEntryKey(protocol)}`)}
                state="known"
                value={protocolCounts[protocol]}
              />
            ))}
          </FactSection>
        </FactPanel>
      </div>
    );
  }

  const primary: Array<[string, string | null]> = [
    ['identifier', resource.identifier],
    ['baseUrl', resource.baseUrl ?? null],
    ['proxyUrl', resource.proxyUrl ?? null],
    ['prefix', resource.prefix ?? t('providersPage.status.none')],
    ['models', String(resource.modelCount)],
    ['headers', String(resource.headerCount)],
  ];

  const metadata: Array<[string, string | null]> = [
    ['authIndex', resource.authIndex ?? null],
    ['excludedModels', String(resource.excludedModelCount)],
    ['apiKeyEntries', String(resource.apiKeyEntryCount)],
  ];

  const openaiConfig =
    resource.brand === 'openaiCompatibility' ? (resource.raw as OpenAIProviderConfig) : null;
  const apiKeyEntries = openaiConfig?.apiKeyEntries ?? [];

  return (
    <div>
      <div className={styles.detailHeader}>
        <div className={styles.sectionTitle}>{resource.name ?? resource.identifier}</div>
      </div>

      <FactPanel>
        <FactSection title={t('account_details.title')}>
          {primary.map(([key, value]) => (
            <Fact
              key={key}
              label={t(`providersPage.detail.fields.${key}`)}
              {...(value === null
                ? {
                    state: 'notReported' as const,
                    reason: t('account_details.not_reported_reason'),
                  }
                : { state: 'known' as const, value })}
              variant={['identifier', 'baseUrl', 'proxyUrl'].includes(key) ? 'code' : undefined}
            />
          ))}
        </FactSection>
      </FactPanel>

      {openaiConfig && apiKeyEntries.length > 0 ? (
        <div className={styles.apiKeyEntriesSection}>
          <div className={styles.apiKeyEntriesLabel}>
            {t('providersPage.form.apiKeyEntriesSection')}: {apiKeyEntries.length}
          </div>
          <div className={styles.apiKeyEntryList}>
            {apiKeyEntries.map((entry, entryIndex) => {
              const entryStats = usageByProvider
                ? getProviderTotalStats(
                    usageByProvider,
                    openaiConfig.name,
                    entry.apiKey,
                    openaiConfig.baseUrl
                  )
                : { success: 0, failure: 0 };
              return (
                <div key={`${entry.apiKey}-${entryIndex}`} className={styles.apiKeyEntryCard}>
                  <span className={styles.apiKeyEntryIndex}>{entryIndex + 1}</span>
                  <span className={styles.apiKeyEntryKey}>{maskApiKey(entry.apiKey)}</span>
                  {entry.proxyUrl ? (
                    <span className={styles.apiKeyEntryProxy}>{entry.proxyUrl}</span>
                  ) : null}
                  <div className={styles.apiKeyEntryStats}>
                    <span className={`${styles.apiKeyEntryStat} ${styles.apiKeyEntryStatSuccess}`}>
                      <IconCheck size={12} /> {entryStats.success}
                    </span>
                    <span className={`${styles.apiKeyEntryStat} ${styles.apiKeyEntryStatFailure}`}>
                      <IconX size={12} /> {entryStats.failure}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Collapsible label={t('providersPage.detail.metadataTitle')}>
          <FactPanel>
            <FactSection title={t('providersPage.detail.metadataTitle')}>
              {metadata.map(([key, value]) => (
                <Fact
                  key={key}
                  label={t(`providersPage.detail.fields.${key}`)}
                  {...(value === null
                    ? {
                        state: 'notReported' as const,
                        reason: t('account_details.not_reported_reason'),
                      }
                    : { state: 'known' as const, value })}
                  variant={key === 'authIndex' ? 'code' : undefined}
                />
              ))}
            </FactSection>
          </FactPanel>
        </Collapsible>
      </div>
    </div>
  );
}
