import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstructorPage } from './instructor-pages';
import * as models from '@/lib/api/models';
import { API_ROOT, ApiError } from '@/lib/api/client';
import { presentApiError } from '@/lib/errors/present';

const session = vi.hoisted(() => ({ id: 'teacher-one', role: 'INSTRUCTOR' }));
vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { ...session, name: 'Teacher' }, status: 'authenticated', logout: vi.fn() }) }));
const courseId = '111111111111111111111111';
const lectureId = '222222222222222222222222';
const materialId = '333333333333333333333333';
const base = `/instructor/courses/${courseId}/materials`;
const course = { _id: courseId, title: 'Learning React', instructor: session.id, lectures: [{ _id: lectureId, title: 'Components' }], accessType: 'FREE', price: 0 };
const material = { id: materialId, courseId, lectureId: null, title: 'Study guide', originalFilename: 'guide.pdf', size: 100,
  status: 'READY', pageCount: 3, chunkCount: 1, failureCode: null, failureMessage: null, createdAt: '', updatedAt: '' };
const clients: QueryClient[] = [];
type Request = { path: string; method: string; body: any; init: RequestInit };
function server(override: (request: Request) => unknown = () => undefined) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    const request = { path: String(input).split('/api/v1')[1]!, method: init.method ?? 'GET', body, init };
    requests.push(request);
    const custom = await override(request);
    if (custom instanceof Response) return custom;
    const data = custom ?? (request.path === '/courses' ? { courses: [course] } : request.path === `/courses/${courseId}` ? { course } : request.path === base ? { materials: [] } : undefined);
    if (!data) throw new Error(`Unexpected endpoint: ${request.path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  return requests;
}
async function mount(section = 'materials') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(qc);
  const root = createRootRoute({ component: () => <InstructorPage section={section} courseId={courseId} /> });
  const routes = ['/', '/instructor', '/instructor/$section', '/courses', '/courses/$courseId', '/login', '/restricted'].map(path => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
  return qc;
}
afterEach(() => { cleanup(); clients.splice(0).forEach(qc => qc.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'INSTRUCTOR'; });

describe('instructor PDF materials', () => {
  it('uploads a course lecture PDF through the credentialed multipart API and refreshes the saved list', async () => {
    let uploaded = false;
    const requests = server(({ path, method }) => path === base ? method === 'POST' ? (uploaded = true, { material }) : { materials: uploaded ? [material] : [] } : undefined);
    await mount();
    expect(await screen.findByRole('heading', { name: 'Materials', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Materials' })).toHaveAttribute('href', '/instructor/materials');
    expect(screen.getByText(/Upload material you are allowed to share with enrolled students/i)).toBeInTheDocument();
    await screen.findByRole('option', { name: 'Components' });
    fireEvent.change(screen.getByLabelText('Material title'), { target: { value: 'Study guide' } });
    fireEvent.change(screen.getByLabelText('Material scope'), { target: { value: lectureId } });
    const input = screen.getByLabelText('PDF file'); expect(input).toHaveAttribute('accept', '.pdf,application/pdf');
    fireEvent.change(input, { target: { files: [new File(['%PDF-guide'], 'guide.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));
    expect(await screen.findByRole('article', { name: 'Study guide' })).toHaveTextContent('3 pages');
    const posted = requests.find(r => r.method === 'POST')!;
    expect(posted.path).toBe(base); expect(posted.init.credentials).toBe('include');
    expect([...posted.body.keys()].sort()).toEqual(['file', 'lectureId', 'title']);
    expect(posted.body.get('title')).toBe('Study guide'); expect(posted.body.get('lectureId')).toBe(lectureId);
    expect(posted.body.get('file').name).toBe('guide.pdf');
    expect(requests.filter(r => r.path === base && r.method === 'GET').length).toBeGreaterThan(1);
  });

  it('rejects wrong extension, MIME and oversized PDFs before any upload', async () => {
    const requests = server(); await mount(); await screen.findByLabelText('PDF file');
    fireEvent.change(screen.getByLabelText('Material title'), { target: { value: 'Notes' } });
    const oversized = new File(['x'], 'large.pdf', { type: 'application/pdf' }); Object.defineProperty(oversized, 'size', { value: 10485761 });
    for (const file of [new File(['x'], 'note.txt', { type: 'application/pdf' }), new File(['x'], 'note.pdf', { type: 'image/png' }), oversized]) {
      fireEvent.change(screen.getByLabelText('PDF file'), { target: { files: [file] } });
      fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/PDF|10 MB/i);
    }
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });

  it('offers only valid lifecycle actions and refreshes publish, unpublish, retry and delete results', async () => {
    let items: Array<Omit<typeof material, 'failureCode' | 'failureMessage'> & { failureCode: string | null; failureMessage: string | null }> = [material, { ...material, id: '444444444444444444444444', title: 'Failed guide', status: 'FAILED', failureCode: 'NO_READABLE_TEXT', failureMessage: 'raw-provider-secret' }, { ...material, id: '555555555555555555555555', title: 'Processing guide', status: 'PROCESSING' }];
    const requests = server(({ path, method, body }) => {
      if (path === base) return { materials: items };
      if (method === 'PATCH') { items = items.map(m => path.includes(m.id) ? { ...m, status: body.status } : m); return { material: items[0] }; }
      if (method === 'POST') { items = items.map(m => path.includes(m.id) ? { ...m, status: 'READY', failureCode: null } : m); return { material: items[1] }; }
      if (method === 'DELETE') { items = items.filter(m => !path.includes(m.id)); return { success: true }; }
      return undefined;
    });
    vi.stubGlobal('confirm', vi.fn(() => true)); await mount();
    const row = await screen.findByRole('article', { name: 'Study guide' });
    expect(within(row).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Processing guide' })).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    const failed = screen.getByRole('article', { name: 'Failed guide' }); expect(failed).toHaveTextContent(/selectable text/i); expect(failed).not.toHaveTextContent('raw-provider-secret');
    fireEvent.click(within(row).getByRole('button', { name: 'Publish' }));
    fireEvent.click(await within(row).findByRole('button', { name: 'Unpublish' }));
    await within(row).findByRole('button', { name: 'Publish' });
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' })); await within(failed).findByRole('button', { name: 'Publish' });
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' })); await waitFor(() => expect(screen.queryByRole('article', { name: 'Study guide' })).not.toBeInTheDocument());
    expect(requests.filter(r => r.method === 'PATCH').map(r => [r.path, r.body])).toEqual([[`${base}/${materialId}/status`, { status: 'PUBLISHED' }], [`${base}/${materialId}/status`, { status: 'READY' }]]);
    expect(requests.find(r => r.path.endsWith('/retry'))?.body).toBeUndefined();
  });

  it('keeps controls busy during upload and uses safe actionable errors on processing failure', async () => {
    let finish!: (value: unknown) => void;
    const requests = server(({ method }) => method === 'POST' ? new Promise(resolve => { finish = resolve; }) : undefined);
    await mount(); await screen.findByLabelText('PDF file');
    fireEvent.change(screen.getByLabelText('Material title'), { target: { value: 'Notes' } });
    fireEvent.change(screen.getByLabelText('PDF file'), { target: { files: [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));
    expect(await screen.findByRole('button', { name: /Uploading/ })).toBeDisabled();
    await act(async () => finish(new Response(JSON.stringify({ error: { code: 'MATERIAL_NO_READABLE_TEXT', message: 'raw-provider-secret' } }), { status: 422 })));
    expect(await screen.findByRole('alert')).toHaveTextContent(/selectable text/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent('raw-provider-secret');
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
  });
});

describe('material DTO boundary', () => {
  it('projects only safe fields and refuses download URLs outside the exact LMS course/material path', () => {
    const raw = { ...material, storage: { key: 'materials/secret.pdf' }, signedUrl: 'https://secret.r2.example/?token=secret', text: 'raw-text', embedding: [1, 2] };
    const instructor = models.toInstructorMaterial(raw);
    expect(JSON.stringify(instructor)).not.toMatch(/secret|storage|embedding|raw-text/);
    const valid = { id: materialId, title: 'Study guide', lectureId: null, pageCount: 3, downloadEndpoint: `/api/v1/courses/${courseId}/materials/${materialId}/download` };
    expect(models.toStudentMaterial({ ...valid, ...raw, downloadEndpoint: valid.downloadEndpoint }, courseId)?.downloadEndpoint).toBe(valid.downloadEndpoint);
    expect(models.toStudentMaterial({ ...valid, downloadEndpoint: raw.signedUrl }, courseId)).toBeNull();
    expect(models.toStudentMaterial(valid, '999999999999999999999999')).toBeNull();
    const result = models.toCourseTutorReply({ outcome: 'ANSWERED', answer: 'A component is reusable.', citations: [{ ...raw, materialId, title: 'Guide', pageStart: 1, pageEnd: 2 }], storage: raw.storage });
    expect(JSON.stringify(result)).not.toMatch(/storage|secret|embedding|raw-text/);
    expect(models.materialDownloadHref(valid.downloadEndpoint, courseId, materialId)).toBe(`${API_ROOT}/courses/${courseId}/materials/${materialId}/download`);
  });

  it.each([
    [422, 'MATERIAL_TOO_MANY_PAGES', /100 pages/i], [422, 'MATERIAL_ENCRYPTED_PDF', /password/i],
    [502, 'MATERIAL_STORAGE_FAILED', /material.*list|refresh/i], [503, 'MATERIAL_UNAVAILABLE', /materials.*unavailable/i],
    [400, 'AI_TUTOR_INVALID', /2000/i], [409, 'MATERIAL_INVALID_TRANSITION', /refresh/i],
  ] as const)('maps %s %s without raw server diagnostics', (status, code, expected) => {
    const shown = presentApiError(new ApiError(status, 'raw-secret', undefined, { code }));
    expect(shown.message).toMatch(expected); expect(shown.message).not.toContain('raw-secret');
  });
});
