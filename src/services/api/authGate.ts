/**
 * One hub's management-key gate. A hub bans an address after five wrong-key attempts in a row, and
 * every Prox request reaches it from the same address, so a wrong key must cost at most one
 * failed request per refresh:
 *
 *   unverified ──first request──▶ probing ──answer──▶ verified
 *                                    │ 401 ──▶ denied (every later request fails here, unsent)
 *                                    │ no answer (network) ──▶ unverified (the next request probes)
 *
 * A gate starts verified: a session exists only after sign-in proved its key for the source's
 * auth scope. While probing, other requests wait for the probe's answer. `arm()` (each refresh)
 * returns a verified gate to unverified, so a key revoked since then is found by one request.
 * A denied gate stays denied for the session: signing in again creates a new session.
 */
import type { ApiError } from '@/types';

type State = 'unverified' | 'probing' | 'verified' | 'denied';

export const AUTH_SKIPPED_CODE = 'ERR_AUTH_SKIPPED';

/** A request the gate refused to send: the hub already rejected this management key. */
export function authSkippedError(): ApiError {
  const error = new Error('Not sent: this hub rejected the management key') as ApiError;
  error.name = 'ApiError';
  error.status = 401;
  error.code = AUTH_SKIPPED_CODE;
  return error;
}

export class AuthGate {
  private state: State = 'verified';
  private waiters: Array<() => void> = [];

  get denied(): boolean {
    return this.state === 'denied';
  }

  /** Resolves `true` when this request is the probe, `false` when it may simply go. */
  async enter(): Promise<boolean> {
    for (;;) {
      if (this.state === 'denied') throw authSkippedError();
      if (this.state === 'verified') return false;
      if (this.state === 'unverified') {
        this.state = 'probing';
        return true;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** The hub answered the probe with something other than 401. */
  verified(): void {
    if (this.state === 'probing') this.state = 'verified';
    this.release();
  }

  /** Any request was answered 401. */
  deny(): void {
    this.state = 'denied';
    this.release();
  }

  /** The probe ended without an answer from the hub; the next request probes instead. */
  unanswered(): void {
    if (this.state === 'probing') this.state = 'unverified';
    this.release();
  }

  /** A new refresh: prove the key again before sending in parallel. */
  arm(): void {
    if (this.state === 'verified') this.state = 'unverified';
  }

  private release() {
    const waiting = this.waiters;
    this.waiters = [];
    waiting.forEach((resolve) => resolve());
  }
}
