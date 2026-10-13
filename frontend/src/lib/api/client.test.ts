import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorText } from './client';

afterEach(() => vi.unstubAllGlobals());

async function failedResponse(body: string, status = 400) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
  try { await api('/example'); } catch (error) { return error as ApiError; }
  throw new Error('Expected request to fail');
}

describe('API failures', () => {
  it('retains the modern code, server message, status and metadata', async () => {
    const message = 'An account already exists for this email. Sign in instead, or reset your password if you do not remember it.';
    const error = await failedResponse(JSON.stringify({ success: false, message: 'Legacy message', error: { code: 'AUTH_EMAIL_EXISTS', message, meta: { retryAfter: 10 } } }), 409);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('AUTH_EMAIL_EXISTS');
    expect(error.serverMessage).toBe(message);
    expect(error.meta).toEqual({ retryAfter: 10 });
    expect(errorText(error)).toBe(message);
  });

  it('retains a legacy message without exposing technical details', async () => {
    const error = await failedResponse(JSON.stringify({ message: 'MongoServerError: duplicate secret.users index' }), 409);
    expect(error.serverMessage).toBe('MongoServerError: duplicate secret.users index');
    expect(errorText(error)).not.toMatch(/Mongo|secret|index/);
  });

  it('reads a nested message without needing the legacy top-level message', async () => {
    const error = await failedResponse(JSON.stringify({ success: false, error: { code: 'AUTH_RESET_TOKEN_INVALID', message: 'This reset link has expired. Request a new one to continue.' }, metadata: { retryAfter: 2 } }));
    expect(error.serverMessage).toBe('This reset link has expired. Request a new one to continue.');
    expect(error.meta).toEqual({ retryAfter: 2 });
    expect(error.message).toBe(error.serverMessage);
  });

  it('retains parsed details separately from the original response body', async () => {
    const error = await failedResponse(JSON.stringify({ success: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid request', details: { fields: ['email'] } } }));
    expect(error.details).toEqual({ fields: ['email'] });
    expect(errorText(error)).toBe('Check the highlighted details and try again.');
  });

  it.each(['Bad gateway: upstream.internal', '{broken json', '', JSON.stringify({ error: { code: '<script>', message: 'Error: SQL failed' } })])('handles malformed and plain error responses safely: %s', async body => {
    const error = await failedResponse(body, 502);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
    expect(errorText(error)).toBe('We couldn’t connect to SkillForge. Check your connection and try again.');
  });

  it('rejects invalid error-code shapes without coercing them', async () => {
    const error = await failedResponse(JSON.stringify({ error: { code: { internal: 'AUTH_EMAIL_EXISTS' }, message: 'Error: backend details' } }));
    expect(error.code).toBeUndefined();
    expect(errorText(error)).not.toContain('backend');
  });

  it('turns network failures into a retryable safe API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch at internal.host')));
    await expect(api('/example')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: 'We couldn’t connect to SkillForge. Check your connection and try again.' });
  });

  it('normalizes a lost connection while reading the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.reject(new TypeError('socket error at secret.host')) }));
    await expect(api('/example')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: 'We couldn’t connect to SkillForge. Check your connection and try again.' });
  });

  it('normalizes unexpected rejection values without throwing another error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(null));
    await expect(api('/example')).rejects.toBeInstanceOf(ApiError);
  });

  it('preserves cancellation rather than treating it as a connection failure', async () => {
    const cancelled = new DOMException('Cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancelled));
    await expect(api('/example')).rejects.toBe(cancelled);
  });

  it('keeps cookie credentials on successful requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { ok: true } })));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/example')).resolves.toEqual({ success: true, data: { ok: true } });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/example'), expect.objectContaining({ credentials: 'include' }));
  });
});
