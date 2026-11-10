import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import {
  authFileStatusWarning,
  summarizeAuthFileStatusMessage,
} from '../src/features/authFiles/constants';
import type { AuthFileItem } from '../src/types';

describe('auth file status summary', () => {
  test('reads a Codex usage limit as its window and reset time', () => {
    const raw = JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'pro',
        resets_at: 1793599839,
        limit_window_minutes: 10080,
      },
    });
    expect(summarizeAuthFileStatusMessage(raw)).toEqual({
      kind: 'usage_limit',
      window: 'weekly',
      resetsAt: 1793599839 * 1000,
    });
    const fiveHour = JSON.stringify({
      error: { type: 'usage_limit_reached', limit_window_minutes: 300 },
    });
    expect(summarizeAuthFileStatusMessage(fiveHour)).toEqual({
      kind: 'usage_limit',
      window: 'five_hour',
      resetsAt: null,
    });
  });

  test('reads a Claude rate-limit error', () => {
    const raw = JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "This request would exceed your account's rate limit.",
      },
      request_id: 'req_1',
    });
    expect(summarizeAuthFileStatusMessage(raw)).toEqual({ kind: 'rate_limit', resetsAt: null });
  });

  test('falls back to the inner message, then to the original text', () => {
    expect(
      summarizeAuthFileStatusMessage(
        JSON.stringify({ error: { type: 'other', message: 'Token expired' } })
      )
    ).toEqual({ kind: 'message', text: 'Token expired' });
    expect(summarizeAuthFileStatusMessage('{"error":"not_found"}')).toEqual({
      kind: 'message',
      text: 'not_found',
    });
    expect(summarizeAuthFileStatusMessage('refresh failed')).toEqual({
      kind: 'message',
      text: 'refresh failed',
    });
    expect(summarizeAuthFileStatusMessage('{broken')).toEqual({ kind: 'message', text: '{broken' });
  });
});

describe('the card warning reads the hub verdict the list carries', () => {
  const rateLimited = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: "This request would exceed your account's rate limit.",
    },
  });
  const claude = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
    name: 'claude-a.json',
    type: 'claude',
    ...overrides,
  });

  test('normalizes the hub retry time of a blocked credential and omits a missing one', () => {
    const { files } = normalizeAuthFilesResponse({
      files: [
        {
          name: 'blocked.json',
          type: 'claude',
          status: 'error',
          unavailable: true,
          status_message: rateLimited,
          next_retry_after: '2026-11-10T14:05:00.123456789Z',
        },
        { name: 'serving.json', type: 'claude', status: 'active' },
      ],
    });
    expect(files.find((file) => file.name === 'blocked.json')?.nextRetryAfter).toBe(
      '2026-11-10T14:05:00.123Z'
    );
    expect(files.find((file) => file.name === 'serving.json')).not.toHaveProperty('nextRetryAfter');
  });

  test('a rate limit says when the hub retries instead of "try again later"', () => {
    const warning = authFileStatusWarning(
      claude({ statusMessage: rateLimited, nextRetryAfter: '2026-11-10T14:05:00.000Z' })
    );
    expect(warning).toEqual({ kind: 'rate_limit', resetsAt: Date.parse('2026-11-10T14:05:00Z') });
    expect(i18n.getFixedT('en')('auth_files.status_rate_limited_until', { time: '14:05' })).toBe(
      'Rate limited · retry after 14:05'
    );
  });

  test('without a retry time the rate limit keeps the general text', () => {
    expect(authFileStatusWarning(claude({ statusMessage: rateLimited }))).toEqual({
      kind: 'rate_limit',
      resetsAt: null,
    });
  });

  test("a usage limit keeps its own reset time over the hub's retry time", () => {
    const usage = JSON.stringify({
      error: { type: 'usage_limit_reached', resets_at: 1793599839, limit_window_minutes: 300 },
    });
    expect(
      authFileStatusWarning(
        claude({ statusMessage: usage, nextRetryAfter: '2026-11-10T14:05:00Z' })
      )
    ).toEqual({ kind: 'usage_limit', window: 'five_hour', resetsAt: 1793599839 * 1000 });
  });

  test('a reloaded list whose credential is serving again clears the banner', () => {
    // The hub drops status_message once the credential is active (reconcileAuthFileCooldownState).
    const before = claude({ status: 'error', unavailable: true, statusMessage: rateLimited });
    const after = normalizeAuthFilesResponse({
      files: [{ name: 'claude-a.json', type: 'claude', status: 'active', status_message: '' }],
    }).files[0];
    expect(authFileStatusWarning(before)).not.toBeNull();
    expect(authFileStatusWarning(after)).toBeNull();
    expect(authFileStatusWarning(claude({ statusMessage: 'ok' }))).toBeNull();
  });

  test('the card renders the warning from authFileStatusWarning, with the reset time', () => {
    const card = readFileSync('src/features/authFiles/components/AuthFileCard.tsx', 'utf8');
    expect(card).toContain('const statusWarning = authFileStatusWarning(file);');
    expect(card).toContain("t('auth_files.status_rate_limited_until'");
    expect(card).toContain('<span>{describeStatus(statusWarning)}</span>');
  });
});
