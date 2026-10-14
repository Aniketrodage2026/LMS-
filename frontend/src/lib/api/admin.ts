import { api } from './client';
import type {
  AdminAuditLogsPage,
  AdminCourseStatusResponse,
  AdminCoursesPage,
  AdminOverview,
  AdminPurchasesPage,
  AdminUsersPage,
  Role,
} from './models';

type CursorFilters = { cursor?: string | undefined; limit?: number | undefined };
export type AdminUserFilters = CursorFilters & { query?: string | undefined; role?: Role | undefined };
export type AdminCourseFilters = CursorFilters & { query?: string | undefined; status?: 'PUBLISHED' | 'UNPUBLISHED' | undefined };
export type AdminPurchaseFilters = CursorFilters & { courseId?: string | undefined };

function withQuery(path: string, values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export function getAdminOverview() {
  return api<AdminOverview>('/admin/overview');
}

export function listAdminUsers(filters: AdminUserFilters = {}) {
  return api<AdminUsersPage>(withQuery('/admin/users', filters));
}

export function listAdminCourses(filters: AdminCourseFilters = {}) {
  return api<AdminCoursesPage>(withQuery('/admin/courses', filters));
}

export function moderateCourseStatus(courseId: string, status: 'PUBLISHED' | 'UNPUBLISHED') {
  return api<AdminCourseStatusResponse>(`/admin/courses/${encodeURIComponent(courseId)}/status`, { method: 'PATCH', body: { status } });
}

export function listAdminPurchases(filters: AdminPurchaseFilters = {}) {
  return api<AdminPurchasesPage>(withQuery('/admin/purchases', filters));
}

export function listAdminAuditLogs(filters: CursorFilters = {}) {
  return api<AdminAuditLogsPage>(withQuery('/admin/audit-logs', filters));
}
