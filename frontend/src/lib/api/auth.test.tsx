import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth';
import { ApiError } from './client';
import * as client from './client';
import { presentApiError } from '../errors/present';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('sign-in profile recovery', () => {
  it('preserves authorization errors after a login that requires loading the profile', async () => {
    const expired = new ApiError(401, 'jwt secret stack', undefined, { code: 'AUTH_REQUIRED' });
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/auth/login') return { success: true };
      throw expired;
    });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe('guest'));
    await act(async () => {
      await expect(result.current.login('learner@example.com', 'password')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    });
    expect(result.current.status).toBe('guest');
    expect(result.current.user).toBeNull();
    expect(presentApiError(expired).action).toMatchObject({ label: 'Sign in', href: '/login' });
  });

  it('keeps a profile service failure retryable rather than losing its recovery code', async () => {
    const failure = new ApiError(503, 'database profile internals', undefined, { code: 'SYSTEM_UNEXPECTED' });
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/auth/login') return { success: true };
      throw failure;
    });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe('guest'));
    await act(async () => {
      await expect(result.current.login('learner@example.com', 'password')).rejects.toMatchObject({ status: 503, code: 'SYSTEM_UNEXPECTED' });
    });
    expect(result.current.user).toBeNull();
  });

  it('does not authenticate an empty profile or send the learner around a protected-route loop', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).not.toBe('loading'));
    expect(result.current.status).toBe('guest');
    await act(async () => {
      await expect(result.current.login('learner@example.com', 'password')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });
    expect(result.current.user).toBeNull();
  });
});
