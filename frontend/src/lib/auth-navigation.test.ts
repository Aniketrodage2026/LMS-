import { describe, expect, it } from 'vitest';
import { authHref, authSearch, safeAuthReturnTo } from './auth-navigation';

describe('auth return destinations', () => {
  it.each([
    '/%6cogin',
    '/./login',
    '/courses/../login',
    '/%2e/login',
    '/./rest-password/secret',
    '/%72egister',
    '/courses/%2e%2e/forgot-password',
    '/%72eset-password/secret',
    '/courses%2f..%2flogin',
  ])('rejects an auth destination after decoding and normalization: %s', returnTo => {
    expect(safeAuthReturnTo(returnTo)).toBeUndefined();
    expect(authSearch({ redirect: returnTo })).toEqual({});
    expect(authHref('/login', returnTo)).toBe('/login');
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/%5cevil.example',
    '/%2f%2fevil.example',
    '/courses/..//evil.example',
    '/learn/%20course-1',
    '/learn/%09course-1',
    '/learn/\u00a0course-1',
    '/learn/%00course-1',
    '/learn/%zz',
  ])('rejects unsafe or malformed destinations: %s', returnTo => {
    expect(safeAuthReturnTo(returnTo)).toBeUndefined();
  });

  it('canonicalizes a safe internal path and preserves its query and hash', () => {
    const returnTo = '/courses/../learn/course-1?lesson=2#notes';
    const canonical = '/learn/course-1?lesson=2#notes';
    expect(safeAuthReturnTo(returnTo)).toBe(canonical);
    expect(authSearch({ redirect: returnTo })).toEqual({ redirect: canonical });
    expect(authHref('/forgot-password', returnTo)).toBe(`/forgot-password?redirect=${encodeURIComponent(canonical)}`);
  });

  it.each(['/learn/course-1?lesson=2#notes', '/courses/course%2Fpart?query=reset-password', '/courses/login-guide'])('preserves safe course destinations: %s', returnTo => {
    expect(safeAuthReturnTo(returnTo)).toBe(returnTo);
  });
});
