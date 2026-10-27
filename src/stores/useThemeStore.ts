/**
 * Prox has one dark theme. Components still read resolvedTheme to pick dark icon variants.
 */

import { create } from 'zustand';

type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  resolvedTheme: ResolvedTheme;
  initializeTheme: () => () => void;
}

export const useThemeStore = create<ThemeState>()(() => ({
  resolvedTheme: 'dark',
  initializeTheme: () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    return () => {};
  },
}));
