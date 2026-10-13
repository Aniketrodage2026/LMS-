import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBox, QueryState } from '@/components/skillforge/shared';
import { ApiError } from '@/lib/api/client';

afterEach(cleanup);

describe('reusable error recovery', () => {
  it('renders an accessible action callback', () => {
    const action = vi.fn();
    render(<ErrorBox message="Choose another file." action={{ label: 'Choose a file', onClick: action }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose another file.');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a file' }));
    expect(action).toHaveBeenCalledOnce();
  });

  it('renders route recovery as a labelled link', () => {
    render(<ErrorBox message="Please sign in to continue." action={{ label: 'Sign in', href: '/login' }} />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('renders all supplied recovery actions and avoids a redundant retry', () => {
    const retry = vi.fn();
    render(<ErrorBox message="Recover your account." actions={[
      { label: 'Log in', href: '/login' },
      { label: 'Reset password', href: '/forgot-password' },
      { kind: 'retry', label: 'Retry request', onClick: retry },
    ]} onRetry={retry} />);
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Reset password' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('omits unavailable actions and preserves existing retry behavior', () => {
    const retry = vi.fn();
    render(<ErrorBox message="Try later." onRetry={retry} action={{ label: 'Undefined action' }} />);
    expect(screen.queryByText('Undefined action')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('renders only one recovery button when the action already retries', () => {
    const retry = vi.fn();
    render(<ErrorBox message="Try later." onRetry={retry} action={{ kind: 'retry', label: 'Retry upload', onClick: retry }} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('safely presents query failures and refetches on retry', () => {
    const refetch = vi.fn();
    render(<QueryState q={{ isLoading: false, error: new Error('Error: MongoDB secret stack'), data: undefined, refetch }}>{() => <p>Loaded</p>}</QueryState>);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/MongoDB|secret|stack|Error:/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('offers sign-in for a failed authorized query without redundant retry', () => {
    render(<QueryState q={{ isLoading: false, error: new ApiError(401, 'jwt malformed'), data: undefined, refetch: vi.fn() }}>{() => <p>Loaded</p>}</QueryState>);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
