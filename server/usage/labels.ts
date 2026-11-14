// Per-source credential snapshots; only the label/account allowlist crosses into the writer.
import type { AccountLabel, AccountLabelLookup } from './types';

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/[\r\n\0]/g, ' ')
        .slice(0, 1024)
    : '';

export class CredentialLabels {
  private labels = new Map<string, AccountLabel>();
  private lastAttempt = -Infinity;
  private lastUnknown = -Infinity;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}

  readonly labelFor: AccountLabelLookup = (index) => this.labels.get(index);

  snapshot(): [string, AccountLabel][] {
    return [...this.labels];
  }

  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.now() - this.lastAttempt < 300_000) return Promise.resolve();
    this.lastAttempt = this.now();
    this.pending = this.load()
      .then((body) => {
        if (!body || typeof body !== 'object' || !('files' in body) || !Array.isArray(body.files)) {
          throw new Error('Invalid credential listing');
        }
        const next = new Map<string, AccountLabel>();
        for (const entry of body.files) {
          if (!entry || typeof entry !== 'object') continue;
          const index = text(entry.auth_index);
          const label = text(entry.label);
          // The backend omits account for API keys. Also guard it here: it can be a raw key.
          const account = entry.account_type === 'api_key' ? '' : text(entry.account);
          // The listing's file name is what CPAMP records as the credential file snapshot.
          if (index) next.set(index, { account: account || label || index, label, file: text(entry.name) });
        }
        this.labels = next;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  unknown(index: string): Promise<void> {
    if (this.labels.has(index) || this.now() - this.lastUnknown < 10_000) {
      return Promise.resolve();
    }
    this.lastUnknown = this.now();
    return this.refresh(true);
  }
}
