/**
 * How a hub decides which models an OAuth account serves. The one place this rule is encoded.
 *
 * Verified against CLIProxyAPI v8.0.44 (the hub image's revision 85eabdce):
 * - sdk/cliproxy/service_models.go:74-82: the provider list `oauth-excluded-models[provider]` is
 *   the default; a NON-EMPTY account list (`excluded_models` in the credential file) replaces it.
 * - internal/watcher/synthesizer/helpers.go:54-86: an empty, whitespace-only or null account list
 *   is never stored, so that account keeps inheriting the provider list.
 * - service_models.go:657-795: patterns are case-insensitive and `*` matches any run of
 *   characters; everything else is literal.
 * - service_models.go:47-53: a disabled account is unregistered and serves nothing.
 *
 * A model is served by the hub when ANY account serves it.
 */
import {
  isWildcardRule,
  matchesExcludedRule,
  normalizeExcludedRules,
} from '@/components/excludedModels/excludedModelRules';

/** An account's own list REPLACES the provider list; it never adds to it. */
export const ACCOUNT_LIST_POLICY = 'replace' as const;

export type RuleSource = 'account' | 'provider' | 'none';

export interface RulesInEffect {
  /** Which list decides for this account. */
  source: RuleSource;
  rules: string[];
}

/** The account has no list of its own (missing, empty or blank), so it follows the provider list. */
export const followsProviderList = (ownList: readonly string[] | null | undefined): boolean =>
  normalizeExcludedRules(ownList ?? []).length === 0;

export function rulesInEffect(
  providerList: readonly string[],
  ownList: readonly string[] | null | undefined
): RulesInEffect {
  if (!followsProviderList(ownList)) {
    return { source: 'account', rules: normalizeExcludedRules(ownList ?? []) };
  }
  const provider = normalizeExcludedRules(providerList);
  return provider.length > 0
    ? { source: 'provider', rules: provider }
    : { source: 'none', rules: [] };
}

export interface BlockingRule {
  rule: string;
  wildcard: boolean;
}

/**
 * The rule that keeps `modelId` from being served, or null. A wildcard wins over an exact rule:
 * removing the exact rule would not serve the model while the wildcard still matches it.
 */
export function blockingRule(rules: readonly string[], modelId: string): BlockingRule | null {
  let exact: string | null = null;
  for (const rule of rules) {
    if (!matchesExcludedRule(rule, modelId)) continue;
    if (isWildcardRule(rule)) return { rule, wildcard: true };
    exact ??= rule;
  }
  return exact === null ? null : { rule: exact, wildcard: false };
}

/** Case-insensitive, order-insensitive list equality; null and [] are the same list. */
export function sameRuleSet(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined
): boolean {
  const key = (list: readonly string[] | null | undefined) =>
    normalizeExcludedRules(list ?? [])
      .map((rule) => rule.toLowerCase())
      .sort()
      .join('\n');
  return key(left) === key(right);
}
