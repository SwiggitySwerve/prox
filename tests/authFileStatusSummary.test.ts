import { describe, expect, test } from 'bun:test';
import { summarizeAuthFileStatusMessage } from '../src/features/authFiles/constants';

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
    expect(summarizeAuthFileStatusMessage(raw)).toEqual({ kind: 'rate_limit' });
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
