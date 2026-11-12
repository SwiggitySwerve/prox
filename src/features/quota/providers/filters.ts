import type { AuthFileItem } from '@/types';
import {
  isAntigravityFile,
  isClaudeFile,
  isCodexFile,
  isDevinFile,
  isKimiFile,
  isPluginQuotaFile,
  isXaiFile,
  resolveAuthProvider,
} from '@/utils/quota';

// Disabled credentials are included: switching one off removes it from request routing, and
// reading its quota sends no model traffic. Cards mark it as off instead.
export const isAntigravityQuotaFile = (file: AuthFileItem): boolean => isAntigravityFile(file);
export const isClaudeQuotaFile = (file: AuthFileItem): boolean => isClaudeFile(file);
export const isCodexQuotaFile = (file: AuthFileItem): boolean => isCodexFile(file);
export const isDevinQuotaFile = (file: AuthFileItem): boolean => isDevinFile(file);
export const isKimiQuotaFile = (file: AuthFileItem): boolean => isKimiFile(file);
export const isMetaQuotaFile = (file: AuthFileItem): boolean =>
  resolveAuthProvider(file) === 'meta';
export const isPluginQuotaTarget = (file: AuthFileItem): boolean => isPluginQuotaFile(file);
export const isXaiQuotaFile = (file: AuthFileItem): boolean => isXaiFile(file);
