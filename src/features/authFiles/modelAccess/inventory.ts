/**
 * The shared model-access data of one source, and the pure derivations every screen uses.
 *
 * `SourceModelAccess` is what the model-access store holds per source: five kinds of slice, each a
 * LoadState (loadState.ts). Nothing here fetches. The Models matrix, the Auth Files summary, the
 * per-account models dialog, the credential sheet's exclusion field and the alias editors all read
 * these slices, so two screens can never disagree about the same list.
 */
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { isRuntimeOnlyAuthFile, normalizeProviderKey } from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import type { AuthFileItem, OAuthModelAliasEntry } from '@/types';
import { IDLE_LOAD, isLoadBusy, loadData, type InventoryLoad, type LoadState } from './loadState';
import type { AccountAccess, AccountKind, ModelAccessInventory } from './resolve';

export interface SourceModelAccess {
  /** The session the slices were read with; another owner's data is never shown. */
  readonly ownerKey: string;
  /** `oauth-excluded-models`: provider key -> rules. */
  readonly providerLists: LoadState<Record<string, string[]>>;
  /** `oauth-model-alias`: provider key -> aliases. */
  readonly aliases: LoadState<Record<string, OAuthModelAliasEntry[]>>;
  /** Static model definitions per provider key. */
  readonly catalogs: Readonly<Record<string, LoadState<AuthFileModelItem[]>>>;
  /** An account's own excluded list per credential file name; null = no list (inherits). */
  readonly accountLists: Readonly<Record<string, LoadState<string[] | null>>>;
  /** `/credentials/models` per credential name (already after exclusions). */
  readonly accountModels: Readonly<Record<string, LoadState<AuthFileModelItem[]>>>;
}

/** The credential facts the model-access data is keyed on; taken from the credential inventory. */
export interface AccountRef {
  name: string;
  label: string;
  disabled: boolean;
  kind: AccountKind;
}

export const providerOfFile = (file: AuthFileItem): string =>
  normalizeProviderKey(String(file.type ?? file.provider ?? ''));

export const accountRefOf = (file: AuthFileItem): AccountRef => ({
  name: file.name,
  label: deriveAuthFileIdentity(file).primary || file.name,
  disabled: file.disabled === true,
  kind: isRuntimeOnlyAuthFile(file) ? 'runtime' : 'file',
});

/** One provider's accounts: credential files first, then runtime credentials (config API keys). */
export function accountRefs(files: readonly AuthFileItem[], provider: string): AccountRef[] {
  const refs = files.filter((file) => providerOfFile(file) === provider).map(accountRefOf);
  return [
    ...refs.filter((ref) => ref.kind === 'file'),
    ...refs.filter((ref) => ref.kind === 'runtime'),
  ];
}

/** Identity of the account set a load depends on: changes when membership or a flag changes. */
export const accountRefsKey = (refs: readonly AccountRef[]): string =>
  refs.map((ref) => `${ref.kind}:${ref.name}:${ref.disabled}`).join('|');

const slice = <T>(map: Readonly<Record<string, LoadState<T>>>, key: string): LoadState<T> =>
  map[key] ?? IDLE_LOAD;

function accountAccess(access: SourceModelAccess, ref: AccountRef): AccountAccess {
  const list = slice(access.accountLists, ref.name);
  const models = slice(access.accountModels, ref.name);
  const listData = loadData(list);
  const modelsData = loadData(models);
  return {
    name: ref.name,
    kind: ref.kind,
    label: ref.label,
    disabled: ref.disabled,
    ownList:
      ref.kind === 'runtime'
        ? { status: 'known', rules: null }
        : list.status === 'ready' || list.status === 'refreshing'
          ? { status: 'known', rules: list.data }
          : list.status === 'error' && listData === null
            ? { status: 'unknown', message: list.message }
            : list.status === 'error'
              ? { status: 'known', rules: listData }
              : { status: 'unknown', message: '' },
    reported: ref.disabled
      ? { status: 'known', ids: [] }
      : modelsData
        ? { status: 'known', ids: modelsData.map((model) => model.id).filter(Boolean) }
        : { status: 'unknown', message: models.status === 'error' ? models.message : '' },
  };
}

/** The inventory the matrix, the write plans and the dialogs are computed from. */
export function buildInventory(
  access: SourceModelAccess,
  provider: string,
  accounts: readonly AccountRef[]
): ModelAccessInventory {
  return {
    provider,
    providerList: loadData(access.providerLists)?.[provider] ?? [],
    catalog: (loadData(slice(access.catalogs, provider)) ?? [])
      .map((model) => model.id)
      .filter(Boolean),
    aliases: loadData(access.aliases)?.[provider] ?? [],
    accounts: accounts.map((ref) => accountAccess(access, ref)),
  };
}

const pending = (state: LoadState<unknown> | undefined): boolean =>
  !state || state.status === 'idle' || state.status === 'loading';

/**
 * One provider's load state for a screen, derived from the slices it needs. Not a second machine:
 * the transitions happen per slice (loadState.ts); this only names their combination.
 *
 *   idle        no provider chosen
 *   loading     a needed slice has no data yet (or the credential list is not known yet)
 *   error       the credential list or the provider lists could not be read and there is no data
 *   refreshing  everything has data and something is being re-read
 *   error+data  the last re-read of the provider lists failed; the previous data stays visible
 *   ready       everything needed is loaded (an account whose own read failed shows as unknown)
 */
export function deriveInventoryLoad(input: {
  access: SourceModelAccess | undefined;
  provider: string;
  accounts: readonly AccountRef[] | undefined;
  /** Why the credential list is missing, once it is known to have failed. */
  credentialError?: string | null;
}): InventoryLoad {
  const { access, provider, accounts } = input;
  if (!provider) return IDLE_LOAD;
  if (!accounts) {
    return input.credentialError
      ? {
          status: 'error',
          generation: 0,
          message: input.credentialError,
          unsupported: false,
          data: null,
        }
      : { status: 'loading', generation: 0 };
  }
  if (!access) return { status: 'loading', generation: 0 };
  const lists = accounts
    .filter((ref) => ref.kind === 'file')
    .map((ref) => access.accountLists[ref.name]);
  const models = accounts
    .filter((ref) => !ref.disabled)
    .map((ref) => access.accountModels[ref.name]);
  const needed = [
    access.providerLists,
    access.aliases,
    access.catalogs[provider],
    ...lists,
    ...models,
  ];
  if (access.providerLists.status === 'error' && loadData(access.providerLists) === null) {
    return {
      status: 'error',
      generation: 0,
      message: access.providerLists.message,
      unsupported: access.providerLists.unsupported,
      data: null,
    };
  }
  if (needed.some(pending)) return { status: 'loading', generation: 0 };
  const data = buildInventory(access, provider, accounts);
  if (access.providerLists.status === 'error') {
    return {
      status: 'error',
      generation: 0,
      message: access.providerLists.message,
      unsupported: access.providerLists.unsupported,
      data,
    };
  }
  return needed.some((state) => state && isLoadBusy(state))
    ? { status: 'refreshing', generation: 0, data }
    : { status: 'ready', generation: 0, data };
}

/** `OAuthConfigLoadError` for the older cards: 'loading' | 'load' | 'unsupported' | null (ready). */
export function configLoadError(
  state: LoadState<unknown> | undefined
): 'loading' | 'load' | 'unsupported' | null {
  if (!state || state.status === 'idle' || state.status === 'loading') return 'loading';
  if (state.status === 'error') return state.unsupported ? 'unsupported' : 'load';
  return null;
}
