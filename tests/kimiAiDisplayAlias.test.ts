import { describe, expect, test } from 'bun:test';
import {
  getAuthFileIcon,
  getTypeColor,
  getTypeLabel,
  isThemeSurfaceIconProvider,
  normalizeProviderKey,
} from '../src/features/authFiles/constants';

const t = ((key: string) => (key === 'auth_files.filter_kimi' ? 'Kimi' : key)) as never;

describe('kimi-ai display alias', () => {
  test('keeps its own provider key but looks up Kimi label, icon and colour', () => {
    expect(normalizeProviderKey('kimi-ai')).toBe('kimi-ai');
    expect(getTypeLabel(t, 'kimi-ai')).toBe('Kimi');
    expect(getAuthFileIcon('kimi-ai', 'light')).toBe(getAuthFileIcon('kimi', 'light'));
    expect(getAuthFileIcon('kimi-ai', 'dark')).not.toBeNull();
    expect(getTypeColor('kimi-ai', 'dark')).toEqual(getTypeColor('kimi', 'dark'));
    expect(isThemeSurfaceIconProvider('kimi-ai')).toBe(true);
  });
});
