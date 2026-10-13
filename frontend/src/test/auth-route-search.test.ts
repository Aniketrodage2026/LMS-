import { describe, expect, it } from 'vitest';
import { Route as login } from '@/routes/login';
import { Route as register } from '@/routes/register';
import { Route as forgot } from '@/routes/forgot-password';
import { Route as reset } from '@/routes/reset-password.$token';
import { Route as resetAlias } from '@/routes/rest-password.$token';

// Exercise the real leaf-route validators without booting app loaders/styles.
describe.each([['login', login], ['register', register], ['forgot', forgot], ['reset', reset], ['email reset alias', resetAlias]] as const)('%s recovery search', (_, route) => {
  it('keeps an internal destination across the recovery routes', () => {
    expect(route.options.validateSearch).toBeTypeOf('function');
    const validate = route.options.validateSearch as (search: Record<string, unknown>) => unknown;
    expect(validate({ redirect: '/learn/course-1?lesson=2', email: 'private@example.com' })).toEqual({ redirect: '/learn/course-1?lesson=2' });
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/login', '/register', '/forgot-password', '/reset-password/secret', '/%6cogin', '/./login', '/courses/../login', '/%2e/login', '/./rest-password/secret', 12])('drops unsafe or circular destination: %s', redirect => {
    expect(route.options.validateSearch).toBeTypeOf('function');
    const validate = route.options.validateSearch as (search: Record<string, unknown>) => unknown;
    expect(validate({ redirect })).toEqual({});
  });
});
