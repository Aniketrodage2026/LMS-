// Reusable API client for the SkillForge Express backend.
// Auth is an HTTP-only cookie named `token`; we never read or store JWTs in the browser.
export const API_ROOT = `${(import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:5000').replace(/\/$/, '')}/api/v1`;

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function friendlyMessage(status: number, serverMessage?: string): string {
  const fallback: Record<number, string> = {
    0: 'We couldn’t reach SkillForge. Check your connection and try again.',
    400: 'Something in the request wasn’t quite right. Please review and try again.',
    401: 'Please sign in to continue.',
    403: 'You don’t have permission to do that.',
    404: 'We couldn’t find what you were looking for.',
    409: 'This conflicts with the current state. It may already exist or be locked.',
    422: 'Some details need your attention. Please review the form.',
    429: 'Too many attempts. Please wait a moment and try again.',
    500: 'Something went wrong on our side. Please try again shortly.',
  };
  const base = fallback[status] ?? (status >= 500 ? fallback[500]! : 'Something went wrong. Please try again.');
  // Server messages for 4xx are usually user-safe and more specific (e.g. "Course already purchased").
  if (serverMessage && status >= 400 && status < 500 && status !== 401) return serverMessage;
  return base;
}

type Options = { method?: string | undefined; body?: unknown; signal?: AbortSignal | undefined; keepalive?: boolean | undefined };

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  let res: Response;
  try {
    const init: RequestInit = { method: opts.method ?? (opts.body ? 'POST' : 'GET'), credentials: 'include' };
    if (opts.body && !isForm) init.headers = { 'Content-Type': 'application/json' };
    if (opts.body) init.body = isForm ? (opts.body as FormData) : JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    if (opts.keepalive) init.keepalive = true;
    res = await fetch(`${API_ROOT}${path}`, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, friendlyMessage(0));
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json && typeof json === 'object' ? (json.message ?? json.error ?? (Array.isArray(json.errors) ? json.errors.map((x: any) => x.msg ?? x.message ?? x).join(', ') : undefined)) : undefined;
    throw new ApiError(res.status, friendlyMessage(res.status, typeof msg === 'string' ? msg : undefined), json);
  }
  return json as T;
}

/** Pull a payload out of common `{ success, data: {...} }` / `{ course: {...} }` envelopes. */
export function pick<T = any>(json: any, ...keys: string[]): T | undefined {
  if (json == null) return undefined;
  for (const src of [json, json?.data]) {
    if (src && typeof src === 'object') for (const k of keys) if (src[k] !== undefined) return src[k];
  }
  if (json?.data !== undefined && keys.length) return json.data;
  return json;
}
export function pickList<T = any>(json: any, ...keys: string[]): T[] {
  const v = pick(json, ...keys);
  if (Array.isArray(v)) return v;
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}
export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
export const errorStatus = (e: unknown) => (e instanceof ApiError ? e.status : 0);
