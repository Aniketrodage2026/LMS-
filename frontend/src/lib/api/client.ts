// Reusable API client for the SkillForge Express backend.
// Auth is an HTTP-only cookie named `token`; we never read or store JWTs in the browser.
import { presentApiError } from '../errors/present';

export const API_ROOT = `${(import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:5000').replace(/\/$/, '')}/api/v1`;

type ErrorOptions = { code?: unknown; serverMessage?: string | undefined; meta?: unknown };
const validCode = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const messageOf = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  serverMessage: string | undefined;
  meta: unknown;
  details: unknown;
  constructor(status: number, message: string, details?: unknown, options: ErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = validCode(options.code);
    this.serverMessage = options.serverMessage ?? messageOf(message);
    this.meta = options.meta;
    this.details = details;
    this.message = presentApiError(this).message;
  }
}

export function friendlyMessage(status: number, serverMessage?: string, code?: string): string {
  return new ApiError(status, serverMessage ?? '', undefined, { code }).message;
}

type Options = { method?: string | undefined; body?: unknown; signal?: AbortSignal | undefined; keepalive?: boolean | undefined };

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  let res: Response;
  let text: string;
  try {
    const init: RequestInit = { method: opts.method ?? (opts.body ? 'POST' : 'GET'), credentials: 'include' };
    if (opts.body && !isForm) init.headers = { 'Content-Type': 'application/json' };
    if (opts.body) init.body = isForm ? (opts.body as FormData) : JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    if (opts.keepalive) init.keepalive = true;
    res = await fetch(`${API_ROOT}${path}`, init);
    text = await res.text();
  } catch (e) {
    if (record(e)?.['name'] === 'AbortError') throw e;
    throw new ApiError(0, '', undefined, { code: 'NETWORK_ERROR' });
  }
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const body = record(json);
    const error = record(body?.['error']);
    const serverMessage = messageOf(error?.['message']) ?? messageOf(body?.['message']) ?? messageOf(body?.['error']) ?? messageOf(json);
    throw new ApiError(res.status, serverMessage ?? '', error?.['details'] ?? body?.['details'] ?? json, {
      code: error?.['code'], serverMessage,
      meta: error?.['meta'] ?? error?.['metadata'] ?? body?.['meta'] ?? body?.['metadata'],
    });
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
export const errorText = (e: unknown) => presentApiError(e).message;
export const errorStatus = (e: unknown) => (e instanceof ApiError ? e.status : 0);
