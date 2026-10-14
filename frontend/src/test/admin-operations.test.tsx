import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as client from '@/lib/api/client';
import * as adminApi from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import { presentApiError } from '@/lib/errors/present';
import {
  getAdminOverview,
  listAdminAuditLogs,
  listAdminCourses,
  listAdminPurchases,
  listAdminUsers,
  moderateCourseStatus,
} from '@/lib/api/admin';
import { AdminPage } from '@/components/skillforge/admin-pages';

vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { id: 'admin-1', name: 'Admin', role: 'ADMIN' }, status: 'authenticated' }) }));
vi.mock('@/components/skillforge/shared', async () => {
  const actual = await vi.importActual<typeof import('@/components/skillforge/shared')>('@/components/skillforge/shared');
  return { ...actual, Workspace: ({ children }: { children: React.ReactNode }) => <main>{children}</main> };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('admin operations API', () => {
  it('gets the administrative overview from its fixed endpoint', async () => {
    const response = { success: true, metrics: {}, recentActivity: [] };
    const request = vi.spyOn(client, 'api').mockResolvedValue(response);

    await expect(getAdminOverview()).resolves.toBe(response);
    expect(request).toHaveBeenCalledWith('/admin/overview');
  });

  it('lists filtered users with URLSearchParams encoding', async () => {
    const response = { success: true, users: [], nextCursor: null };
    const request = vi.spyOn(client, 'api').mockResolvedValue(response);

    await expect(listAdminUsers({ query: 'ana', role: 'STUDENT', limit: 25 })).resolves.toBe(response);
    expect(request).toHaveBeenCalledWith('/admin/users?query=ana&role=STUDENT&limit=25');
  });

  it('omits undefined user filters', async () => {
    const request = vi.spyOn(client, 'api').mockResolvedValue({ success: true, users: [], nextCursor: null });

    await listAdminUsers({ query: undefined, cursor: undefined });
    expect(request).toHaveBeenCalledWith('/admin/users');
  });

  it('lists courses with status and cursor filters', async () => {
    const request = vi.spyOn(client, 'api').mockResolvedValue({ success: true, courses: [], nextCursor: null });

    await listAdminCourses({ status: 'PUBLISHED', cursor: 'next page' });
    expect(request).toHaveBeenCalledWith('/admin/courses?status=PUBLISHED&cursor=next+page');
  });

  it('updates a course status through the encoded moderation endpoint', async () => {
    const response = { success: true, course: { id: 'course-1' } };
    const request = vi.spyOn(client, 'api').mockResolvedValue(response);

    await expect(moderateCourseStatus('course-1', 'UNPUBLISHED')).resolves.toBe(response);
    expect(request).toHaveBeenCalledWith('/admin/courses/course-1/status', { method: 'PATCH', body: { status: 'UNPUBLISHED' } });
  });

  it('encodes course identifiers before moderation', async () => {
    const request = vi.spyOn(client, 'api').mockResolvedValue({ success: true, course: {} });

    await moderateCourseStatus('course/one', 'PUBLISHED');
    expect(request).toHaveBeenCalledWith('/admin/courses/course%2Fone/status', { method: 'PATCH', body: { status: 'PUBLISHED' } });
  });

  it('lists verified purchases with defined filters only', async () => {
    const request = vi.spyOn(client, 'api').mockResolvedValue({ success: true, purchases: [], nextCursor: null });

    await listAdminPurchases({ courseId: 'course id', limit: 10 });
    expect(request).toHaveBeenCalledWith('/admin/purchases?courseId=course+id&limit=10');
  });

  it('uses the existing audit-log endpoint and its entries envelope', async () => {
    const response = { success: true, entries: [], nextCursor: null };
    const request = vi.spyOn(client, 'api').mockResolvedValue(response);

    await expect(listAdminAuditLogs({ limit: 25, cursor: 'opaque' })).resolves.toBe(response);
    expect(request).toHaveBeenCalledWith('/admin/audit-logs?limit=25&cursor=opaque');
  });
});

describe('admin invalid-request guidance', () => {
  it('uses approved corrective copy and never exposes server text', () => {
    const error = new ApiError(400, 'cursor parser leaked a database secret', undefined, { code: 'ADMIN_INVALID_REQUEST' });

    expect(presentApiError(error)).toMatchObject({
      message: 'Check the filters or paging details and try again.',
      action: { kind: 'correct-input', label: 'Review the filters or paging details' },
      retryable: false,
    });
  });

  it('keeps administrative service failures retryable', () => {
    expect(presentApiError(new ApiError(503, 'database details', undefined, { code: 'ADMIN_INVALID_REQUEST' }))).toMatchObject({
      action: { kind: 'retry' },
      retryable: true,
    });
  });
});

const overview = {
  success: true as const,
  metrics: { users: { total: 12, students: 9, instructors: 2, admins: 1 }, courses: { total: 4, published: 2 }, activeEnrollments: 20, purchases: { verifiedCount: 3, verifiedRevenuePaise: 125000, currency: 'INR' as const }, learning: { completedLectures: 30, totalLectureSlots: 50, completionPercent: 60 } },
  recentActivity: [],
};

describe('admin live screens', () => {
  it('shows verified revenue in the live overview without placeholder copy', async () => {
    vi.spyOn(adminApi, 'getAdminOverview').mockResolvedValue(overview);
    render(<AdminPage />);
    expect(await screen.findByText('Verified revenue')).toBeInTheDocument();
    expect(screen.getByText(/₹1,250/)).toBeInTheDocument();
    expect(screen.queryByText(/API coming next|Not connected yet/i)).not.toBeInTheDocument();
  });

  it('confirms a course unpublish then refetches only the course list', async () => {
    const courses = vi.spyOn(adminApi, 'listAdminCourses').mockResolvedValue({ success: true, courses: [{ id: 'course-1', title: 'Safe Course', description: '', thumbnail: null, instructor: null, accessType: 'PAID', price: 50000, currency: 'INR', status: 'PUBLISHED', lectureCount: 2, createdAt: '', updatedAt: '' }], nextCursor: null });
    const overviewRequest = vi.spyOn(adminApi, 'getAdminOverview').mockResolvedValue(overview);
    const moderate = vi.spyOn(adminApi, 'moderateCourseStatus').mockResolvedValue({ success: true, course: {} as never });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPage section="courses" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(moderate).toHaveBeenCalledWith('course-1', 'UNPUBLISHED'));
    await waitFor(() => expect(courses).toHaveBeenCalledTimes(2));
    expect(overviewRequest).not.toHaveBeenCalled();
    expect(await screen.findByText(/Course status updated/i)).toBeInTheDocument();
  });

  it('shows safe retry guidance when course moderation fails', async () => {
    vi.spyOn(adminApi, 'listAdminCourses').mockResolvedValue({ success: true, courses: [{ id: 'course-1', title: 'Safe Course', description: '', thumbnail: null, instructor: null, accessType: 'PAID', price: 50000, currency: 'INR', status: 'PUBLISHED', lectureCount: 2, createdAt: '', updatedAt: '' }], nextCursor: null });
    vi.spyOn(adminApi, 'moderateCourseStatus').mockRejectedValue(new ApiError(503, 'database secret'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPage section="courses" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unpublish' }));
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/database secret/i)).not.toBeInTheDocument();
  });

  it('searches and filters users, confirms the role change, then refetches', async () => {
    const users = vi.spyOn(adminApi, 'listAdminUsers').mockResolvedValue({ success: true, users: [{ id: 'user-1', name: 'Asha', email: 'asha@example.test', avatar: null, role: 'STUDENT', createdAt: '' }], nextCursor: null });
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPage section="users" />);
    const search = await screen.findByLabelText('Search users');
    fireEvent.change(search, { target: { value: 'Asha' } });
    fireEvent.change(screen.getByLabelText('Role filter'), { target: { value: 'INSTRUCTOR' } });
    await waitFor(() => expect(users).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'Asha', role: 'INSTRUCTOR' })));
    fireEvent.click(screen.getByRole('button', { name: 'Make instructor' }));
    await waitFor(() => expect(client.api).toHaveBeenCalledWith('/admin/users/user-1/role', { method: 'PATCH', body: { role: 'INSTRUCTOR' } }));
    await waitFor(() => expect(users).toHaveBeenCalledTimes(4));
  });

  it('does not duplicate the current cursor page when a user mutation refreshes it', async () => {
    const user = (id: string, name: string) => ({ id, name, email: `${id}@example.test`, avatar: null, role: 'STUDENT' as const, createdAt: '' });
    const users = vi.spyOn(adminApi, 'listAdminUsers')
      .mockResolvedValueOnce({ success: true, users: [user('user-1', 'First user')], nextCursor: 'next' })
      .mockResolvedValueOnce({ success: true, users: [user('user-2', 'Second user')], nextCursor: 'next' })
      .mockResolvedValueOnce({ success: true, users: [user('user-2', 'Second user')], nextCursor: 'next' });
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPage section="users" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second user')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Make instructor' })[1]!);
    await waitFor(() => expect(client.api).toHaveBeenCalled());
    await waitFor(() => expect(users).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByText('Second user')).toHaveLength(1));
  });

  it('replaces the refreshed cursor page when a role change removes a filtered user', async () => {
    const user = (id: string, name: string) => ({ id, name, email: `${id}@example.test`, avatar: null, role: 'STUDENT' as const, createdAt: '' });
    vi.spyOn(adminApi, 'listAdminUsers')
      .mockResolvedValueOnce({ success: true, users: [], nextCursor: null })
      .mockResolvedValueOnce({ success: true, users: [user('user-1', 'First student')], nextCursor: 'next' })
      .mockResolvedValueOnce({ success: true, users: [user('user-2', 'Changed student')], nextCursor: 'next' })
      .mockResolvedValueOnce({ success: true, users: [user('user-3', 'Replacement student')], nextCursor: null });
    vi.spyOn(client, 'api').mockResolvedValue({ success: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPage section="users" />);
    fireEvent.change(await screen.findByLabelText('Role filter'), { target: { value: 'STUDENT' } });
    expect(await screen.findByText('First student')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Changed student')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Make instructor' })[1]!);
    expect(await screen.findByText('Replacement student')).toBeInTheDocument();
    expect(screen.getByText('First student')).toBeInTheDocument();
    expect(screen.queryByText('Changed student')).not.toBeInTheDocument();
  });

  it('renders payment records without provider or order fields', async () => {
    vi.spyOn(adminApi, 'listAdminPurchases').mockResolvedValue({ success: true, purchases: [{ id: 'purchase-1', student: { id: 'student-1', name: 'Mina', email: 'mina@example.test' }, course: null, amount: 99900, currency: 'INR', verifiedAt: '2026-01-01T00:00:00.000Z' }], nextCursor: null });
    render(<AdminPage section="payments" />);
    expect(await screen.findByText('Mina')).toBeInTheDocument();
    expect(screen.getByText('Course unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/provider|order id|signature/i)).not.toBeInTheDocument();
  });

  it('loads another activity page only when its cursor is available', async () => {
    const activity = vi.spyOn(adminApi, 'listAdminAuditLogs')
      .mockResolvedValueOnce({ success: true, entries: [{ id: 'audit-1', actor: 'admin-1', action: 'COURSE_UPDATED', target: { type: 'COURSE', id: 'course-1' }, summary: { status: 'PUBLISHED' }, createdAt: '2026-01-01T00:00:00.000Z' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ success: true, entries: [{ id: 'audit-2', actor: 'admin-2', action: 'USER_UPDATED', target: { type: 'USER', id: 'user-1' }, summary: { role: 'INSTRUCTOR' }, createdAt: '2026-01-02T00:00:00.000Z' }], nextCursor: null });
    render(<AdminPage section="analytics" />);
    expect(await screen.findByText('COURSE_UPDATED')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith({ cursor: 'next' }));
    expect(await screen.findByText('USER_UPDATED')).toBeInTheDocument();
    expect(screen.getByText('COURSE_UPDATED')).toBeInTheDocument();
  });

  it('shows loading, empty, and retryable error recovery states', async () => {
    const request = vi.spyOn(adminApi, 'listAdminPurchases').mockImplementation(() => new Promise(() => {}));
    const view = render(<AdminPage section="payments" />);
    expect(screen.getByLabelText('Loading payments')).toBeInTheDocument();
    view.unmount();
    request.mockRejectedValueOnce(new ApiError(503, 'secret')).mockResolvedValueOnce({ success: true, purchases: [], nextCursor: null });
    render(<AdminPage section="payments" />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No verified purchases yet')).toBeInTheDocument();
  });
});
