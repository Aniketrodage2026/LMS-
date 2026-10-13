import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CourseDetailPage } from '@/components/skillforge/public-pages';
import { StudentPage } from '@/components/skillforge/student-pages';
import * as client from '@/lib/api/client';

const fixtures = vi.hoisted(() => ({ purchases: [] as any[] }));
vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ status: 'authenticated', user: { id: 'student-1', role: 'STUDENT', name: 'A Learner', email: 'learner@example.com' } }) }));
vi.mock('@/lib/api/hooks', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/hooks')>();
  const { toCourse } = await import('@/lib/api/models');
  const course = toCourse({ _id: 'course-1', title: 'Learning React', accessType: 'PAID', price: 500 });
  return {
    ...original,
    useCourse: () => ({ isLoading: false, error: null, data: course, refetch: vi.fn() }),
    useMyLearning: () => ({ isLoading: false, error: null, data: [], refetch: vi.fn() }),
    usePurchases: () => ({ isLoading: false, error: null, data: fixtures.purchases, refetch: vi.fn() }),
  };
});
vi.mock('@/components/skillforge/shared', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/skillforge/shared')>(),
  Header: () => null, Footer: () => null,
  Workspace: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const clients: QueryClient[] = [];
async function renderPage(page: ReactNode = <CourseDetailPage id="course-1" />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(qc);
  const root = createRootRoute({ component: () => page });
  const routes = ['/', '/courses', '/courses/$courseId', '/student/$section', '/learn/$courseId'].map(path => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}
const reusable = { success: true, code: 'PAYMENT_ORDER_REUSABLE', purchase: { status: 'PENDING' }, order: { id: 'same-order', amount: 500, currency: 'INR' }, keyId: 'public-key' };
afterEach(() => { cleanup(); clients.splice(0).forEach(qc => qc.clear()); vi.restoreAllMocks(); delete window.Razorpay; document.querySelectorAll('script[src*="checkout.razorpay.com"]').forEach(s => s.remove()); fixtures.purchases = []; });

describe('checkout recovery actions on course and purchases screens', () => {
  it('resumes a dismissed checkout using the same server-approved order', async () => {
    const request = vi.spyOn(client, 'api').mockResolvedValue(reusable);
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Buy Course/ }));
    await waitFor(() => expect(options).toHaveLength(1));
    act(() => options[0].modal.ondismiss());
    expect(screen.getByRole('button', { name: 'Resume checkout' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Checkout paused' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume checkout' }));
    await waitFor(() => expect(options).toHaveLength(2));
    expect(options.map(o => o.order_id)).toEqual(['same-order', 'same-order']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('offers recovery after script failure without losing the unpaid order', async () => {
    vi.spyOn(client, 'api').mockResolvedValue(reusable);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Buy Course/ }));
    await waitFor(() => expect(document.querySelector('script[src*="checkout.razorpay.com"]')).not.toBeNull());
    fireEvent.error(document.querySelector('script[src*="checkout.razorpay.com"]')!);
    const resume = await screen.findByRole('button', { name: 'Resume checkout' });
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    fireEvent.click(resume);
    await waitFor(() => expect(options[0]?.order_id).toBe('same-order'));
  });

  it('offers a server check after a lost order response and reopens only the returned reusable order', async () => {
    vi.spyOn(client, 'api').mockRejectedValueOnce(new client.ApiError(0, 'private stack')).mockResolvedValue(reusable);
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Buy Course/ }));
    const check = await screen.findByRole('button', { name: 'Check checkout' });
    expect(screen.getByRole('alert')).not.toHaveTextContent('private stack');
    fireEvent.click(check);
    await waitFor(() => expect(options[0]?.order_id).toBe('same-order'));
  });

  it('keeps a submitted payment paused with purchases guidance and no resume action', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true, code: 'PAYMENT_VERIFICATION_PENDING' });
    const razorpay = vi.fn(); window.Razorpay = razorpay;
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Buy Course/ }));
    expect(await screen.findByRole('button', { name: 'Checkout paused' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'View purchases' })).toHaveAttribute('href', '/student/purchases');
    expect(screen.queryByRole('button', { name: 'Resume checkout' })).not.toBeInTheDocument();
    expect(razorpay).not.toHaveBeenCalled();
  });

  it('shows pending history with a safe checkout check while counting only verified investments', async () => {
    fixtures.purchases = [
      { id: 'unpaid', amount: 500, status: 'PENDING', code: 'PAYMENT_ORDER_PENDING', course: { id: 'course-1', title: 'Unpaid React' } },
      { id: 'submitted', amount: 500, status: 'PENDING', code: 'PAYMENT_VERIFICATION_PENDING', course: { id: 'course-2', title: 'Submitted React' } },
      { id: 'owned', amount: 500, status: 'VERIFIED', course: { id: 'course-3', title: 'Owned React' } },
    ];
    await renderPage(<StudentPage section="purchases" />);
    const unpaid = screen.getByText('Unpaid React').closest('tr')!;
    expect(within(unpaid).getByRole('link', { name: 'Check checkout' })).toHaveAttribute('href', '/courses/course-1');
    expect(within(unpaid).queryByRole('button', { name: 'Download receipt' })).not.toBeInTheDocument();
    const submitted = screen.getByText('Submitted React').closest('tr')!;
    expect(within(submitted).getByText(/verification pending/i)).toBeInTheDocument();
    expect(within(submitted).getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', 'mailto:help@skillforge.example');
    expect(within(submitted).queryByRole('link', { name: /checkout/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download receipt' })).toHaveLength(1);
    expect(screen.getByText('Courses purchased').parentElement).toHaveTextContent('1');
  });
});
