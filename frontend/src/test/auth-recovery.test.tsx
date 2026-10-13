import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from '@/components/skillforge/auth-pages';
import { ApiError } from '@/lib/api/client';
import * as client from '@/lib/api/client';

const auth = vi.hoisted(() => ({
  user: null, status: 'guest', login: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
}));
vi.mock('@/lib/api/auth', () => ({ useAuth: () => auth }));

const returnTo = '/learn/course-1?lesson=2';
const search = `?redirect=${encodeURIComponent(returnTo)}`;
const coded = (status: number, code: string) => new ApiError(status, 'Error: database password and token details', undefined, { code });

// A small real router keeps navigation semantics without the app root's styles,
// loaders, or network requests. The screens and recovery UI are rendered intact.
async function renderPage(page: ReactNode) {
  const root = createRootRoute({ component: () => page });
  const routes = ['/', '/login', '/register', '/forgot-password', '/dashboard', '/instructor', '/admin', '/learn/$courseId'].map(path => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<RouterProvider router={router} />);
  return router;
}

function fill(field: string, value: string) {
  fireEvent.change(screen.getByLabelText(field), { target: { value } });
}

function submit(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('registration recovery', () => {
  it('shows approved duplicate guidance, both recovery links, and preserves entered values and destination', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(coded(409, 'AUTH_EMAIL_EXISTS'));
    await renderPage(<RegisterPage redirect={returnTo} />);
    fill('Full name', 'A Learner'); fill('Email address', 'learner@example.com'); fill('Password', 'new-password');
    submit('Create account');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An account already exists for this email. Sign in instead, or reset your password if you do not remember it.');
    expect(within(alert).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', `/login${search}`);
    expect(within(alert).getByRole('link', { name: 'Reset password' })).toHaveAttribute('href', `/forgot-password${search}`);
    expect(alert).not.toHaveTextContent(/database|token|Error:/);
    expect(screen.getByLabelText('Full name')).toHaveValue('A Learner');
    expect(screen.getByLabelText('Email address')).toHaveValue('learner@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('new-password');
  });

  it('keeps unexpected failures safe and allows resubmission', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(new Error('MongoDB secret stack'));
    await renderPage(<RegisterPage />);
    fill('Full name', 'A Learner'); fill('Email address', 'learner@example.com'); fill('Password', 'new-password');
    submit('Create account');
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/MongoDB|secret|stack/);
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('returns to the requested course after successful registration and profile refresh', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    auth.refresh.mockResolvedValue({ id: 'student-1', role: 'STUDENT' });
    const router = await renderPage(<RegisterPage redirect={returnTo} />);
    fill('Full name', 'A Learner'); fill('Email address', 'learner@example.com'); fill('Password', 'new-password');
    await act(async () => { submit('Create account'); });
    expect(router.state.location.href).toBe(returnTo);
  });
});

describe('sign-in recovery', () => {
  it('shows the approved non-enumerating credential message and password-reset link', async () => {
    auth.login.mockRejectedValue(coded(401, 'AUTH_INVALID_CREDENTIALS'));
    await renderPage(<LoginPage redirect={returnTo} />);
    fill('Email address', 'learner@example.com'); fill('Password', 'wrong-password'); submit('Sign in');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t sign you in with that email and password. Check your details or reset your password.');
    expect(within(alert).getByRole('link', { name: 'Reset password' })).toHaveAttribute('href', `/forgot-password${search}`);
    expect(alert).not.toHaveTextContent(/database|token|Error:/);
    expect(screen.getByLabelText('Email address')).toHaveValue('learner@example.com');
  });

  it('directs an expired session back to sign in with its destination', async () => {
    auth.login.mockRejectedValue(coded(401, 'AUTH_REQUIRED'));
    await renderPage(<LoginPage redirect={returnTo} />);
    fill('Email address', 'learner@example.com'); fill('Password', 'password'); submit('Sign in');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please sign in to continue.');
    expect(within(alert).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login${search}`);
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/login', '/%6cogin', '/./login', '/courses/../login', '/%2e/login', '/./rest-password/secret'])('uses the role workspace for an unsafe or auth-page destination: %s', async redirect => {
    auth.login.mockResolvedValue({ id: 'student-1', role: 'STUDENT' });
    const router = await renderPage(<LoginPage redirect={redirect} />);
    fill('Email address', 'learner@example.com'); fill('Password', 'password');
    await act(async () => { submit('Sign in'); });
    expect(router.state.location.pathname).toBe('/dashboard');
  });
});

describe('forgot-password recovery', () => {
  it('renders the same accessible confirmation for known and unknown email, without exposing either', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true, message: 'If an account exists for this email, a reset link is on its way.' });
    const confirmations: string[] = [];
    for (const email of ['known@example.com', 'unknown@example.com']) {
      await renderPage(<ForgotPage redirect={returnTo} />);
      fill('Email address', email); submit('Send reset link');
      await screen.findByText(/If an account exists for this email/);
      const confirmation = screen.getByRole('status');
      expect(confirmation).toHaveTextContent('If an account exists for this email, a reset link is on its way.');
      expect(confirmation).toHaveTextContent(/email may take a moment/i);
      expect(document.body).not.toHaveTextContent(email);
      expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', `/login${search}`);
      confirmations.push(confirmation.textContent ?? '');
      cleanup();
    }
    expect(confirmations[0]).toBe(confirmations[1]);
  });

  it('announces sending, prevents duplicate requests, and safely shows retryable failure', async () => {
    let reject!: (error: unknown) => void;
    vi.spyOn(client, 'api').mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    await renderPage(<ForgotPage />);
    fill('Email address', 'known@example.com'); submit('Send reset link');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Sending reset link…');
    expect(screen.getByLabelText('Email address').closest('form')).toHaveAttribute('aria-busy', 'true');
    await act(async () => { reject(coded(503, 'SYSTEM_UNEXPECTED')); });
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t connect to SkillForge. Check your connection and try again.');
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
    expect(screen.getByLabelText('Email address')).toHaveValue('known@example.com');
  });
});

describe('reset-password recovery', () => {
  it('offers a fresh link with exact approved copy for an expired token', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(coded(400, 'AUTH_RESET_TOKEN_INVALID'));
    await renderPage(<ResetPage token="private-token" redirect={returnTo} />);
    fill('New password', 'new-password'); fill('Confirm password', 'new-password'); submit('Update password');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This reset link has expired. Request a new one to continue.');
    expect(within(alert).getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', `/forgot-password${search}`);
    expect(alert).not.toHaveTextContent(/private-token|database|Error:/);
  });

  it('validates password length before sending the reset request', async () => {
    const request = vi.spyOn(client, 'api');
    await renderPage(<ResetPage token="private-token" />);
    fill('New password', 'short'); fill('Confirm password', 'short');
    fireEvent.submit(screen.getByLabelText('New password').closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 8 characters for your password.');
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(request).not.toHaveBeenCalled();
  });

  it('associates a mismatch message with the confirmation input and preserves values', async () => {
    const request = vi.spyOn(client, 'api');
    await renderPage(<ResetPage token="private-token" />);
    fill('New password', 'new-password'); fill('Confirm password', 'other-password'); submit('Update password');
    const confirm = screen.getByLabelText('Confirm password');
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords don’t match.');
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).toHaveAccessibleDescription('Passwords don’t match.');
    expect(confirm).toHaveValue('other-password');
    expect(request).not.toHaveBeenCalled();
  });

  it('announces successful reset and links back to sign in with the original destination', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    await renderPage(<ResetPage token="private-token" redirect={returnTo} />);
    fill('New password', 'new-password'); fill('Confirm password', 'new-password'); submit('Update password');
    await screen.findByText('Your password has been updated.');
    expect(screen.getByRole('status')).toHaveTextContent('Your password has been updated.');
    expect(screen.getByRole('main')).not.toHaveTextContent('private-token');
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login${search}`);
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});
