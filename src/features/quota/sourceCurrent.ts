import type { SourceSession } from '@/services/api/sourceSession';

export function isQuotaSourceCurrent(session?: SourceSession): boolean {
  try {
    session?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
