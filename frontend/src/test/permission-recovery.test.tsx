import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorGuidance, RequireRole } from '@/components/skillforge/shared';
import { ApiError } from '@/lib/api/client';
import type { Role } from '@/lib/api/models';
import { presentApiError } from '@/lib/errors/present';

const session = vi.hoisted(() => ({ role: 'STUDENT' }));
vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { id: 'user-1', role: session.role }, status: 'authenticated' }) }));
afterEach(cleanup);

it.each([
  ['STUDENT', '/student/my-learning'],
  ['INSTRUCTOR', '/instructor'],
  ['ADMIN', '/admin'],
] as const)('permission recovery reaches the guarded %s workspace without a redirect loop', async (role, href) => {
  session.role = role;
  const root = createRootRoute({ component: Outlet });
  const denied = createRoute({ getParentRoute: () => root, path: '/denied', component: () => <ErrorGuidance error={presentApiError(new ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN' }), { workspaceRole: role })} /> });
  const routes = (['STUDENT', 'INSTRUCTOR', 'ADMIN'] as Role[]).map(workspaceRole => createRoute({
    getParentRoute: () => root,
    path: workspaceRole === 'ADMIN' ? '/admin' : workspaceRole === 'INSTRUCTOR' ? '/instructor' : '/student/my-learning',
    component: () => <RequireRole roles={[workspaceRole]}><p>{workspaceRole} workspace loaded</p></RequireRole>,
  }));
  const restricted = createRoute({ getParentRoute: () => root, path: '/restricted', component: () => <p>Wrong workspace</p> });
  const router = createRouter({ routeTree: root.addChildren([denied, ...routes, restricted]), history: createMemoryHistory({ initialEntries: ['/denied'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<RouterProvider router={router} />);
  const recovery = await screen.findByRole('link');
  expect(recovery).toHaveAttribute('href', href);
  await act(async () => { await router.navigate({ to: recovery.getAttribute('href')! }); });
  expect(await screen.findByText(`${role} workspace loaded`)).toBeInTheDocument();
  expect(router.state.location.pathname).toBe(href);
  expect(screen.queryByText('Wrong workspace')).not.toBeInTheDocument();
});
