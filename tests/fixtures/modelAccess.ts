import type {
  AccountAccess,
  ModelAccessInventory,
} from '../../src/features/authFiles/modelAccess/resolve';
import { rulesInEffect, blockingRule } from '../../src/features/authFiles/modelAccess/accessRule';

/** Same synthetic hub as scripts/visual/fake_hub.py (alpha / claude). */
export const CATALOG = [
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
  'claude-haiku-4-5',
  'claude-3-7-sonnet',
  'claude-3-5-haiku',
];
export const PROVIDER_LIST = ['claude-3-*', 'claude-sonnet-4-0'];

/** What the hub would report: catalog (+extra) minus no-access minus the rules in effect. */
export function reportedFor(
  providerList: string[],
  own: string[] | null,
  options: { extra?: string[]; noAccess?: string[]; disabled?: boolean } = {}
): string[] {
  if (options.disabled) return [];
  const { rules } = rulesInEffect(providerList, own);
  return [...CATALOG, ...(options.extra ?? [])]
    .filter((id) => !(options.noAccess ?? []).includes(id))
    .filter((id) => !blockingRule(rules, id));
}

export function account(
  name: string,
  own: string[] | null,
  options: { extra?: string[]; noAccess?: string[]; disabled?: boolean } = {},
  providerList = PROVIDER_LIST
): AccountAccess {
  return {
    name,
    kind: 'file',
    label: name.replace(/\.json$/, '@example.invalid'),
    disabled: options.disabled === true,
    ownList: { status: 'known', rules: own },
    reported: { status: 'known', ids: reportedFor(providerList, own, options) },
  };
}

export function inventory(overrides: Partial<ModelAccessInventory> = {}): ModelAccessInventory {
  return {
    provider: 'claude',
    providerList: PROVIDER_LIST,
    catalog: CATALOG,
    aliases: [{ name: 'claude-opus-4-5', alias: 'opus' }],
    accounts: [
      account('team-a.json', null),
      account('team-b.json', ['claude-3-*', 'claude-opus-4-1'], { extra: ['claude-preview-x'] }),
      account('pro-c.json', null, { disabled: true }),
      account('max-d.json', null, { noAccess: ['claude-opus-4-5'] }),
    ],
    ...overrides,
  };
}

/** A config API-key credential: no file, read-only here, serves exactly `ids`. */
export function runtimeAccount(name: string, ids: string[], disabled = false): AccountAccess {
  return {
    name,
    kind: 'runtime',
    label: name,
    disabled,
    ownList: { status: 'known', rules: null },
    reported: { status: 'known', ids: disabled ? [] : ids },
  };
}
