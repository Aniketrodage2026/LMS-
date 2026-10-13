export type AuthSearch = { redirect?: string };

const internalOrigin = 'https://skillforge.invalid';
const unsafePathCharacters = /[\\\s\u0000-\u0020\u007f]/;
const authPath = /^\/(?:login|register|forgot-password|reset-password|rest-password)(?:\/|$)/i;

/** Return only internal destinations outside the sign-in/recovery flow. */
export function safeAuthReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || unsafePathCharacters.test(value)) return undefined;
  try {
    const destination = new URL(value, internalOrigin);
    // Browsers remove dot segments and the router decodes path segments. Check
    // that destination too, including separators hidden by percent encoding.
    const decodedPath = decodeURIComponent(destination.pathname);
    if (decodedPath.startsWith('//') || unsafePathCharacters.test(decodedPath)) return undefined;
    const canonical = new URL(decodedPath, internalOrigin);
    if (destination.origin !== internalOrigin || canonical.origin !== internalOrigin || canonical.pathname.startsWith('//') || authPath.test(canonical.pathname)) return undefined;
    // Keep encoded path parameters and query/hash data intact while removing
    // the original path's dot segments before it reaches navigation.
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return undefined;
  }
}

export function authSearch(search: Record<string, unknown>): AuthSearch {
  const redirect = safeAuthReturnTo(search['redirect']);
  return redirect ? { redirect } : {};
}

export function authHref(path: '/login' | '/forgot-password', returnTo?: string): string {
  const redirect = safeAuthReturnTo(returnTo);
  return redirect ? `${path}?redirect=${encodeURIComponent(redirect)}` : path;
}
