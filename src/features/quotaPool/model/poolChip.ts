import type { PoolForecastState } from '@/domain/quotaPool/types';

export type PoolChipIcon = 'check' | 'partial' | 'stale' | 'saved' | 'collecting' | 'info';

/** One chip per card in every state: a word and an icon, each icon used for one status only. */
export function poolChip(
  forecastState: PoolForecastState,
  savedData: boolean
): { state: PoolForecastState | 'saved'; icon: PoolChipIcon; tone: 'neutral' | 'warning' } {
  if (savedData) return { state: 'saved', icon: 'saved', tone: 'warning' };
  switch (forecastState) {
    case 'ready':
      return { state: forecastState, icon: 'check', tone: 'neutral' };
    case 'partial':
      return { state: forecastState, icon: 'partial', tone: 'warning' };
    case 'stale':
      return { state: forecastState, icon: 'stale', tone: 'warning' };
    case 'collecting':
      return { state: forecastState, icon: 'collecting', tone: 'neutral' };
    default:
      return { state: forecastState, icon: 'info', tone: 'neutral' };
  }
}
