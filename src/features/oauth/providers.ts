import type { BuiltInOAuthProvider } from '@/services/api';
import type { ProviderCatalog, ProviderCatalogEntry } from '@/domain/providerCatalog';
import { canonicalCredentialProvider } from '@/domain/providerSources/ownership';
import { isManagementOAuthProviderKey, normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { getPluginTitle, resolvePluginAssetURL } from '@/features/plugins/pluginResources';
import {
  KIMI_CHINESE_AFFILIATE_URL,
  KIMI_INTERNATIONAL_AFFILIATE_URL,
} from '@/features/providers/kimi';
import type { PluginListEntry } from '@/types';
import iconMeta from '@/assets/icons/meta.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconAntigravity from '@/assets/icons/antigravity.svg';
// 赞助卡用的 App 图标版：K 与蓝点等比内缩进方块，蓝点不再顶出圆角
import iconKimiTileBlack from '@/assets/icons/kimi-tile-black.svg';
import iconKimiTileWhite from '@/assets/icons/kimi-tile-white.svg';
import iconGrok from '@/assets/icons/grok.svg';
import iconGrokDark from '@/assets/icons/grok-dark.svg';
import iconDevin from '@/assets/icons/devin.svg';
import iconDevinDark from '@/assets/icons/devin-dark.svg';

export type ThemedIcon = string | { light: string; dark: string };

/** 设备码流程会返回 user_code；浏览器流程依赖回调（本地自动 / 远程手动粘贴）。 */
export type OAuthFlowKind = 'device' | 'browser';

export interface BuiltInOAuthProviderCard {
  kind: 'builtin';
  id: BuiltInOAuthProvider;
  /** 磁贴短名：品牌名是常量（与仪表盘 providerLabel 一致），区域站点走 i18n。 */
  label: string | { key: string };
  /** 对话框标题，沿用 `auth_login.<id>_oauth_title`。 */
  titleKey: string;
  icon: ThemedIcon;
  flow: OAuthFlowKind;
  /** 区分同品牌的不同站点，磁贴副行展示。 */
  domain?: string;
  /**
   * 登录时才需要知道的注意事项（账号类型、站点不互通、时限），以 InfoTip 挂在
   * 「打开授权页」步骤标题后。只说「通过 OAuth 登录并保存认证文件」的提供商不设。
   */
  signInNoteKey?: string;
  /**
   * 赞助商：同品牌的各站点合并进画廊首行的一张品牌卡，每站一个登录入口 + 开放平台注册链接
   * （目前是 Kimi 国内站 / 国际站）。`siteKey` 是卡内站点短名（品牌名由卡片标题承载）。
   */
  sponsor?: SponsorSite;
  /** The hub's catalog lists this provider with no credentials yet. */
  awaitingAuth?: boolean;
}

export interface SponsorSite {
  signUpUrl: string;
  siteKey: string;
}

/** A plugin's OAuth provider, or one the hub's catalog advertises without a built-in tile. */
export interface PluginOAuthProviderCard {
  kind: 'plugin';
  id: string;
  title: string;
  /** Empty for a discovered provider without a logo: the tile shows the fallback glyph. */
  icon: string;
  /** From the catalog; plugin-list cards leave these unset. */
  flow?: OAuthFlowKind;
  manualCallback?: boolean;
  webui?: boolean;
  awaitingAuth?: boolean;
}

export type OAuthProviderCard = BuiltInOAuthProviderCard | PluginOAuthProviderCard;

/** 展示顺序即数组顺序：赞助商（Kimi 两站）置首，其余沿用原有次序。 */
export const OAUTH_PROVIDERS: BuiltInOAuthProviderCard[] = [
  {
    kind: 'builtin',
    id: 'kimi',
    label: { key: 'auth_login.kimi_oauth_name' },
    titleKey: 'auth_login.kimi_oauth_title',
    icon: { light: iconKimiTileBlack, dark: iconKimiTileWhite },
    flow: 'device',
    domain: 'kimi.com',
    signInNoteKey: 'auth_login.kimi_oauth_hint',
    sponsor: { signUpUrl: KIMI_CHINESE_AFFILIATE_URL, siteKey: 'auth_login.sponsor_site_china' },
  },
  {
    kind: 'builtin',
    id: 'kimi-ai',
    label: { key: 'auth_login.kimi_ai_oauth_name' },
    titleKey: 'auth_login.kimi_ai_oauth_title',
    icon: { light: iconKimiTileBlack, dark: iconKimiTileWhite },
    flow: 'device',
    domain: 'kimi.ai',
    signInNoteKey: 'auth_login.kimi_ai_oauth_hint',
    sponsor: {
      signUpUrl: KIMI_INTERNATIONAL_AFFILIATE_URL,
      siteKey: 'auth_login.sponsor_site_international',
    },
  },
  {
    kind: 'builtin',
    id: 'meta',
    label: 'Muse (Meta)',
    titleKey: 'auth_login.meta_oauth_title',
    icon: iconMeta,
    flow: 'device',
  },
  {
    kind: 'builtin',
    id: 'codex',
    label: 'Codex',
    titleKey: 'auth_login.codex_oauth_title',
    icon: iconCodex,
    flow: 'browser',
  },
  {
    kind: 'builtin',
    id: 'anthropic',
    label: 'Claude',
    titleKey: 'auth_login.anthropic_oauth_title',
    icon: iconClaude,
    flow: 'browser',
  },
  {
    kind: 'builtin',
    id: 'antigravity',
    label: 'Antigravity',
    titleKey: 'auth_login.antigravity_oauth_title',
    icon: iconAntigravity,
    flow: 'browser',
    signInNoteKey: 'auth_login.antigravity_oauth_hint',
  },
  {
    kind: 'builtin',
    id: 'xai',
    label: 'xAI',
    titleKey: 'auth_login.xai_oauth_title',
    icon: { light: iconGrok, dark: iconGrokDark },
    flow: 'browser',
  },
  {
    kind: 'builtin',
    id: 'devin',
    label: 'Devin',
    titleKey: 'auth_login.devin_oauth_title',
    icon: { light: iconDevin, dark: iconDevinDark },
    flow: 'browser',
    signInNoteKey: 'auth_login.devin_oauth_hint',
  },
];

const BUILTIN_PROVIDER_IDS = new Set<string>(OAUTH_PROVIDERS.map((provider) => provider.id));

/** 后端接受手动回调提交的内置提供商；插件提供商一律允许。 */
export const CALLBACK_SUPPORTED = new Set<string>([
  'codex',
  'anthropic',
  'antigravity',
  'xai',
  'devin',
]);

export const supportsManualCallback = (provider: OAuthProviderCard): boolean =>
  provider.kind === 'plugin'
    ? (provider.manualCallback ?? true)
    : CALLBACK_SUPPORTED.has(provider.id);

export const isSponsor = (
  provider: OAuthProviderCard
): provider is BuiltInOAuthProviderCard & { sponsor: SponsorSite } =>
  provider.kind === 'builtin' && Boolean(provider.sponsor);

export const resolveThemedIcon = (icon: ThemedIcon, theme: 'light' | 'dark'): string =>
  typeof icon === 'string' ? icon : icon[theme];

/**
 * 一个插件可能声明多个登录入口（各自带标题与图标），每个入口一张卡；
 * v8.0.49 之前只有单个 `oauth_provider`，那时仍然只出一张卡。
 */
export const buildPluginOAuthProviderCards = (
  plugins: PluginListEntry[],
  apiBase: string
): PluginOAuthProviderCard[] => {
  const seenProviders = new Set(BUILTIN_PROVIDER_IDS);
  return plugins.flatMap((plugin) => {
    if (!plugin.supportsOAuth || !plugin.effectiveEnabled) return [];
    const declared = plugin.oauthProviders?.length
      ? plugin.oauthProviders
      : plugin.oauthProvider
        ? [plugin.oauthProvider]
        : [];
    const pluginTitle = getPluginTitle(plugin);
    const pluginLogo = plugin.logo || plugin.metadata?.logo || '';
    return declared.flatMap((provider) => {
      if (seenProviders.has(provider)) return [];
      seenProviders.add(provider);
      const entry = plugin.oauthProviderEntries?.find((item) => item.identifier === provider);
      return [
        {
          kind: 'plugin' as const,
          id: provider,
          title: entry?.name?.trim() || pluginTitle,
          icon: resolvePluginAssetURL(entry?.logo?.trim() || pluginLogo, apiBase),
        },
      ];
    });
  });
};

/**
 * Whether a catalog entry describes this built-in tile (catalog ids are credential types). Only
 * built-in entries do: a plugin keeps its own id even when a display alias folds it onto a
 * built-in's (a `grok` plugin is not the xAI tile).
 */
const matchesBuiltIn = (card: BuiltInOAuthProviderCard, entry: ProviderCatalogEntry): boolean => {
  if (entry.source !== 'builtin') return false;
  const entryKey = normalizeOAuthProviderKey(entry.id);
  return (
    card.id === entryKey ||
    canonicalCredentialProvider(card.id) === entryKey ||
    entry.oauth?.aliases.some((alias) => normalizeOAuthProviderKey(alias) === card.id) === true
  );
};

/**
 * OAuth tiles from a hub's provider catalog. Built-in tiles keep their presentation (label, icon,
 * sponsor) and order; providers the catalog adds follow in catalog order with the catalog's name
 * and logo. Only entries with an OAuth flow appear. `include` lets the caller drop providers the
 * hub would refuse (not accepted here and not routed to another hub).
 */
export const buildCatalogOAuthProviderCards = (
  catalog: ProviderCatalog,
  apiBase: string,
  include: (providerId: string) => boolean = () => true
): OAuthProviderCard[] => {
  const entries = catalog.providers.filter((entry) => entry.oauth !== null && include(entry.id));
  const claimed = new Set<ProviderCatalogEntry>();
  const builtIns = OAUTH_PROVIDERS.flatMap((card) => {
    const entry = entries.find((candidate) => matchesBuiltIn(card, candidate));
    if (!entry) return [];
    claimed.add(entry);
    return [{ ...card, awaitingAuth: entry.lifecycle === 'awaiting_auth' }];
  });
  const discovered = entries.flatMap((entry): PluginOAuthProviderCard[] => {
    // The id is sent as-is to the OAuth start route, which only takes management keys
    // (no underscores); a provider it cannot name cannot be signed in from here.
    const id = entry.id;
    if (
      claimed.has(entry) ||
      !isManagementOAuthProviderKey(id) ||
      (entry.source === 'builtin' && BUILTIN_PROVIDER_IDS.has(normalizeOAuthProviderKey(id))) ||
      BUILTIN_PROVIDER_IDS.has(id)
    ) {
      return [];
    }
    return [
      {
        kind: 'plugin',
        id,
        title: entry.displayName,
        icon: entry.logo ? resolvePluginAssetURL(entry.logo, apiBase) : '',
        flow: entry.oauth?.flow,
        manualCallback: entry.oauth?.manualCallback,
        webui: entry.oauth?.webui,
        awaitingAuth: entry.lifecycle === 'awaiting_auth',
      },
    ];
  });
  return [...builtIns, ...discovered];
};
