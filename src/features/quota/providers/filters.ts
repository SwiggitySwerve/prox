import type { AuthFileItem } from '@/types';
import {
  isAntigravityFile,
  isClaudeFile,
  isCodexFile,
  isDevinFile,
  isKimiFile,
  isPluginQuotaFile,
  isXaiFile,
  isDisabledAuthFile,
  resolveAuthProvider,
} from '@/utils/quota';

export const isAntigravityQuotaFile = (file: AuthFileItem): boolean =>
  isAntigravityFile(file) && !isDisabledAuthFile(file);
export const isClaudeQuotaFile = (file: AuthFileItem): boolean =>
  isClaudeFile(file) && !isDisabledAuthFile(file);
export const isCodexQuotaFile = (file: AuthFileItem): boolean =>
  isCodexFile(file) && !isDisabledAuthFile(file);
export const isDevinQuotaFile = (file: AuthFileItem): boolean =>
  isDevinFile(file) && !isDisabledAuthFile(file);
export const isKimiQuotaFile = (file: AuthFileItem): boolean =>
  isKimiFile(file) && !isDisabledAuthFile(file);
export const isMetaQuotaFile = (file: AuthFileItem): boolean =>
  resolveAuthProvider(file) === 'meta' && !isDisabledAuthFile(file);
export const isEnabledPluginQuotaFile = (file: AuthFileItem): boolean =>
  isPluginQuotaFile(file) && !isDisabledAuthFile(file);
export const isXaiQuotaFile = (file: AuthFileItem): boolean =>
  isXaiFile(file) && !isDisabledAuthFile(file);
