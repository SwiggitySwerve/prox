/**
 * Where to go once the user is signed in: the full location (path, query, hash) that
 * ProtectedRoute bounced to /login. Router state is only ever set by the app itself, but it
 * is still checked so a crafted history entry cannot send anyone off-site or back to /login.
 */
export function redirectTarget(state: unknown): string {
  const from = (state as { from?: Record<string, unknown> } | null)?.from;
  const pathname = from?.pathname;
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('\\') ||
    pathname === '/login'
  ) {
    return '/';
  }
  const search = typeof from?.search === 'string' && from.search.startsWith('?') ? from.search : '';
  const hash = typeof from?.hash === 'string' && from.hash.startsWith('#') ? from.hash : '';
  return `${pathname}${search}${hash}`;
}
