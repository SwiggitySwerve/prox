import { describe, expect, test } from 'bun:test';
import { formatCompactNumber, formatPercent } from '../src/utils/format';
import {
  getProviderKeyCounts,
  providerIdOfAuthFile,
  summarizeCredentials,
} from '../src/features/dashboard/hooks/useDashboardOverview';
import { countCredentials } from '../src/features/authFiles/credentialFacts';
import type { AuthFileItem } from '../src/types';
import {
  axisMax,
  formatBucketLength,
  niceCeil,
  providerLabel,
  splitWindowMinutes,
  toneForSuccessRate,
} from '../src/features/dashboard/utils';

describe('formatCompactNumber', () => {
  test('leaves values below one thousand alone', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  test('compacts with a single decimal and no redundant .0', () => {
    expect(formatCompactNumber(1000)).toBe('1K');
    expect(formatCompactNumber(1284)).toBe('1.3K');
    expect(formatCompactNumber(12_900)).toBe('12.9K');
    expect(formatCompactNumber(1_500_000)).toBe('1.5M');
  });

  test('carries into the next tier instead of rendering 1000K', () => {
    expect(formatCompactNumber(999_999)).toBe('1M');
    expect(formatCompactNumber(999_999_999)).toBe('1B');
  });

  test('keeps the sign and survives non-finite input', () => {
    expect(formatCompactNumber(-1500)).toBe('-1.5K');
    expect(formatCompactNumber(Number.NaN)).toBe('0');
  });
});

describe('formatPercent', () => {
  test('trims trailing zeros but keeps meaningful decimals', () => {
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(99.5)).toBe('99.5%');
    expect(formatPercent(0)).toBe('0%');
  });

  test('renders an em dash for non-finite rates', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('niceCeil', () => {
  test('rounds up onto the step ladder', () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(7)).toBe(8);
    expect(niceCeil(12)).toBe(15);
    expect(niceCeil(48)).toBe(50);
    expect(niceCeil(320)).toBe(400);
  });

  test('never returns zero, so bar heights cannot divide by zero', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
  });
});

describe('axisMax', () => {
  test('lands every gridline on a whole number', () => {
    // 峰值 112 → 上限 120（刻度 0/30/60/90/120），而不是浪费半张图的 200
    expect(axisMax(112, 4)).toBe(120);
    expect(axisMax(7, 4)).toBe(8);
    expect(axisMax(1533, 4)).toBe(1600);
  });

  test('keeps the axis just above the peak', () => {
    for (const peak of [1, 3, 9, 17, 64, 112, 250, 999, 4321]) {
      const max = axisMax(peak, 4);
      expect(max).toBeGreaterThanOrEqual(peak);
      // 上限不应超过峰值的两倍，否则柱子被压得太矮。
      // 峰值极小时受「每格至少 1」约束，下限就是间隔数本身。
      expect(max).toBeLessThanOrEqual(Math.max(4, peak * 2));
      // 每格都必须是整数
      expect(Number.isInteger(max / 4)).toBe(true);
    }
  });

  test('degrades safely with no traffic', () => {
    expect(axisMax(0, 4)).toBe(4);
    expect(axisMax(-3, 4)).toBe(4);
  });
});

describe('toneForSuccessRate', () => {
  test('maps a rate onto a severity band', () => {
    expect(toneForSuccessRate(null)).toBe('idle');
    expect(toneForSuccessRate(100)).toBe('good');
    expect(toneForSuccessRate(95)).toBe('good');
    expect(toneForSuccessRate(94.9)).toBe('warning');
    expect(toneForSuccessRate(80)).toBe('warning');
    expect(toneForSuccessRate(79.9)).toBe('critical');
  });
});

describe('splitWindowMinutes', () => {
  test('splits the rolling window into hours and minutes', () => {
    expect(splitWindowMinutes(200)).toEqual({ hours: 3, minutes: 20 });
    expect(splitWindowMinutes(60)).toEqual({ hours: 1, minutes: 0 });
    expect(splitWindowMinutes(40)).toEqual({ hours: 0, minutes: 40 });
  });
});

describe('provider key counts', () => {
  test('includes Muse API keys and defaults missing configuration to zero', () => {
    expect(getProviderKeyCounts({ metaApiKeys: [{ apiKey: 'fixture-meta-key' }] }).meta).toBe(1);
    expect(getProviderKeyCounts({}).meta).toBe(0);
  });
  test('includes native Interactions API keys in the dashboard total inputs', () => {
    const counts = getProviderKeyCounts({
      geminiApiKeys: [{ apiKey: 'gemini-key' }],
      interactionsApiKeys: [{ apiKey: 'interactions-1' }, { apiKey: 'interactions-2' }],
      codexApiKeys: [{ apiKey: 'codex-key' }],
    });

    expect(counts.interactions).toBe(2);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(4);
  });
});

describe('providerLabel', () => {
  test('uses the brand spelling for known providers', () => {
    expect(providerLabel('xai', 'Unattributed')).toBe('xAI');
    expect(providerLabel('aistudio', 'Unattributed')).toBe('AI Studio');
    expect(providerLabel('gemini-interactions', 'Unattributed')).toBe('Interactions API');
  });

  test('falls back to a capitalised id, and localises unknown', () => {
    expect(providerLabel('somenewbrand', 'Unattributed')).toBe('Somenewbrand');
    expect(providerLabel('unknown', 'Unattributed')).toBe('Unattributed');
    expect(providerLabel('', 'Unattributed')).toBe('Unattributed');
  });
});

describe('formatBucketLength', () => {
  test('names minute and hour buckets in the reader language', () => {
    expect(formatBucketLength(10, 'en')).toBe('10 minutes');
    expect(formatBucketLength(60, 'en')).toBe('1 hour');
    expect(formatBucketLength(120, 'en')).toBe('2 hours');
    expect(formatBucketLength(60, 'ko')).toBe('1시간');
  });
});

describe('summarizeCredentials', () => {
  const file = (fields: Record<string, unknown>): AuthFileItem =>
    ({ name: 'f.json', type: 'claude', ...fields }) as AuthFileItem;
  // 10 credentials: 1 disabled, 2 unavailable, 1 with a warning message, 1 in error status.
  const files = [
    ...Array.from({ length: 5 }, () => file({})),
    file({ disabled: true }),
    file({ unavailable: true }),
    file({ unavailable: true }),
    file({ status: 'error', status_message: 'token expired' }),
    file({ status: 'active', status_message: 'quota exceeded, retrying' }),
  ];

  test('active, problem and disabled add up to the total and match the Auth Files counts', () => {
    const health = summarizeCredentials(files);
    const counts = countCredentials(files);
    expect(health.total).toBe(10);
    expect(health.active + health.problem + health.disabled).toBe(health.total);
    expect({ active: health.active, problem: health.problem, disabled: health.disabled }).toEqual({
      active: counts.active,
      problem: counts.problem,
      disabled: counts.disabled,
    });
    expect(health.disabled).toBe(1);
    expect(health.problem).toBeGreaterThanOrEqual(3);
  });

  test('a disabled credential that also reports a problem is counted once, as disabled', () => {
    const health = summarizeCredentials([file({ disabled: true, unavailable: true })]);
    expect(health).toMatchObject({ total: 1, active: 0, problem: 0, disabled: 1 });
  });

  test('groups by the shared provider key, with unnamed ones under unknown', () => {
    const health = summarizeCredentials([
      file({ type: 'grok' }),
      file({ type: 'x-ai' }),
      file({ type: 'Gemini_CLI' }),
      file({ type: '' }),
      file({ type: 'empty' }),
    ]);
    expect(health.byType).toEqual([
      { type: 'unknown', count: 2 },
      { type: 'xai', count: 2 },
      { type: 'gemini-cli', count: 1 },
    ]);
  });
});

describe('providerIdOfAuthFile', () => {
  test('uses the shared provider key and unknown for unnamed credentials', () => {
    expect(providerIdOfAuthFile({ name: 'a', type: 'Muse' } as AuthFileItem)).toBe('meta');
    expect(providerIdOfAuthFile({ name: 'a', provider: 'x_ai' } as AuthFileItem)).toBe('xai');
    expect(providerIdOfAuthFile({ name: 'a' } as AuthFileItem)).toBe('unknown');
  });
});
