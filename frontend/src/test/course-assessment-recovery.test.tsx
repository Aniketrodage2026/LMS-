import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstructorPage } from '@/components/skillforge/instructor-pages';
import { StudentPage } from '@/components/skillforge/student-pages';
import { AdminPage } from '@/components/skillforge/admin-pages';
import { QuizPage, AssignmentPage } from '@/components/skillforge/assessment-pages';
import * as client from '@/lib/api/client';
import * as adminApi from '@/lib/api/admin';

const querySettings = vi.hoisted(() => ({ liveCourses: false }));
vi.mock('@/lib/api/hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/hooks')>();
  return {
  ...actual,
  useMyLearning: () => ({ isLoading: false, error: null, data: [{ course: { id: 'course-1', title: 'Learning React' }, progress: 0 }], refetch: vi.fn() }),
  useCourse: () => ({ isLoading: false, error: null, data: undefined, refetch: vi.fn() }),
  useCourses: () => querySettings.liveCourses ? actual.useCourses() : ({ isLoading: false, error: null, data: [{ id: 'course-1', title: 'Learning React' }], refetch: vi.fn() }),
}; });
const session = vi.hoisted(() => ({ role: 'INSTRUCTOR' }));
vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { id: 'instructor-1', role: session.role }, status: 'authenticated' }) }));
// Isolate the workspace shell's auth/navigation queries; keep the real screens,
// query hooks, router links, error presenter, and QueryState recovery intact.
vi.mock('@/components/skillforge/shared', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/skillforge/shared')>(),
  Workspace: ({ children }: { children: ReactNode }) => <>{children}</>,
  RequireRole: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const clients: QueryClient[] = [];
async function renderPage(page: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  const root = createRootRoute({ component: () => page });
  const routes = ['/', '/courses/$courseId', '/quizzes/$courseId/$quizId', '/assignments/$courseId/$assignmentId', '/instructor/$section', '/learn/$courseId', '/student/$section', '/verify'].map(path => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

afterEach(() => { cleanup(); clients.splice(0).forEach(qc => qc.clear()); vi.restoreAllMocks(); session.role = 'INSTRUCTOR'; querySettings.liveCourses = false; });

describe('instructor assessment lookup recovery', () => {
  it('shows assignment loading before a successful empty grading list', async () => {
    let resolve!: (value: unknown) => void;
    vi.spyOn(client, 'api').mockReturnValue(new Promise(done => { resolve = done; }));
    await renderPage(<InstructorPage section="submissions" courseId="course-1" />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No assignments')).not.toBeInTheDocument();
    await act(async () => { resolve({ assignments: [] }); });
    expect(await screen.findByText('No assignments')).toBeInTheDocument();
  });

  it('shows an assignment lookup failure and retries before displaying grading work', async () => {
    let failing = true;
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path.endsWith('/assignments')) {
        if (failing) throw new Error('database secret');
        return { assignments: [{ id: 'assignment-1', title: 'React project', maxMarks: 100 }] };
      }
      return { submissions: [{ id: 'submission-1', status: 'SUBMITTED' }] };
    });
    await renderPage(<InstructorPage section="submissions" courseId="course-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/database|secret/);
    expect(screen.queryByText('No assignments')).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Marks (out of 100)')).toBeInTheDocument();
    expect(screen.getByLabelText('Assignment')).toHaveValue('assignment-1');
  });

  it('preserves assignment selection and grading feedback through a failed list refetch and retry', async () => {
    let failing = false;
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path.endsWith('/assignments')) {
        if (failing) throw new Error('database secret');
        return { assignments: [{ id: 'assignment-1', title: 'First project', maxMarks: 100 }, { id: 'assignment-2', title: 'Second project', maxMarks: 100 }] };
      }
      return { submissions: [{ id: path.includes('assignment-2') ? 'submission-2' : 'submission-1', status: 'SUBMITTED' }] };
    });
    await renderPage(<InstructorPage section="submissions" courseId="course-1" />);
    await screen.findByLabelText('Feedback');
    fireEvent.change(screen.getByLabelText('Assignment'), { target: { value: 'assignment-2' } });
    fireEvent.change(await screen.findByLabelText('Feedback'), { target: { value: 'Unsaved review feedback' } });
    failing = true;
    await act(async () => { await clients[0]!.invalidateQueries({ queryKey: ['instructor-assignments', 'course-1'] }); });
    const alert = await screen.findByRole('alert');
    expect(screen.getByLabelText('Feedback')).toHaveValue('Unsaved review feedback');
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Assignment')).toHaveValue('assignment-2');
    expect(screen.getByLabelText('Feedback')).toHaveValue('Unsaved review feedback');
  });

  it('shows course loading before a successful empty course picker', async () => {
    querySettings.liveCourses = true;
    let resolve!: (value: unknown) => void;
    vi.spyOn(client, 'api').mockReturnValue(new Promise(done => { resolve = done; }));
    await renderPage(<InstructorPage section="quizzes" />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No courses available')).not.toBeInTheDocument();
    await act(async () => { resolve({ courses: [] }); });
    expect(await screen.findByText('No courses available')).toBeInTheDocument();
  });

  it('shows a course picker failure with safe permission context', async () => {
    querySettings.liveCourses = true;
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN' }));
    await renderPage(<InstructorPage section="quizzes" />);
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/database|secret/);
    expect(within(alert).getByRole('link', { name: 'Go to instructor workspace' })).toHaveAttribute('href', '/instructor');
    expect(screen.queryByText('No courses available')).not.toBeInTheDocument();
  });

  it('preserves the selected course and assessment draft through course picker retry', async () => {
    querySettings.liveCourses = true;
    let failing = false;
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/courses') {
        if (failing) throw new Error('database secret');
        return { courses: [{ id: 'course-1', title: 'First course' }, { id: 'course-2', title: 'Second course' }] };
      }
      return { quizzes: [] };
    });
    await renderPage(<InstructorPage section="quizzes" courseId="course-2" />);
    expect(await screen.findByLabelText('Course')).toHaveValue('course-2');
    fireEvent.click(screen.getByRole('button', { name: 'New quiz' }));
    fireEvent.change(screen.getByLabelText('Quiz title'), { target: { value: 'Unsaved quiz draft' } });
    failing = true;
    await act(async () => { await clients[0]!.invalidateQueries({ queryKey: ['courses'] }); });
    const alert = await screen.findByRole('alert');
    expect(screen.getByLabelText('Quiz title')).toHaveValue('Unsaved quiz draft');
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Course')).toHaveValue('course-2');
    expect(screen.getByLabelText('Quiz title')).toHaveValue('Unsaved quiz draft');
  });
});

describe('assessment, certificate, and role mutation recovery', () => {
  it.each(['quizzes', 'assignments'])('preserves the local %s draft until conflict refresh visibly loads the updated server list', async section => {
    let changed = false;
    const assessment = { id: 'assessment-1', title: 'Original server title', status: 'DRAFT', maxMarks: 100, instructions: 'Original instructions', passMark: 80, questions: [{ prompt: 'Choose one', options: ['First', 'Second'], correctOptionIndex: 0 }] };
    vi.spyOn(client, 'api').mockImplementation(async (_path, opts) => {
      if (opts?.body) { changed = true; throw new client.ApiError(409, 'database secret', undefined, { code: 'ASSESSMENT_REVIEW_CONFLICT' }); }
      return { [section]: [{ ...assessment, title: changed ? 'Updated server title' : assessment.title }] };
    });
    await renderPage(<InstructorPage section={section} courseId="course-1" />);
    fireEvent.click(await screen.findByRole('button', { name: section === 'quizzes' ? 'Edit quiz' : 'Edit assignment' }));
    const title = screen.getByLabelText(section === 'quizzes' ? 'Quiz title' : 'Title');
    fireEvent.change(title, { target: { value: 'My unsaved draft' } });
    fireEvent.click(screen.getByRole('button', { name: section === 'quizzes' ? 'Save quiz' : 'Save assignment' }));
    const alert = await screen.findByRole('alert');
    expect(title).toHaveValue('My unsaved draft');
    expect(screen.queryByText('Updated server title')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Refresh assessment' }));
    expect(await screen.findByText('Updated server title')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('My unsaved draft')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: section === 'quizzes' ? 'Edit quiz' : 'Edit assignment' })).toBeInTheDocument();
  });
  it('keeps quiz answers and provides course recovery if submission becomes unavailable', async () => {
    vi.spyOn(client, 'api').mockImplementation(async (path, opts) => {
      if (opts?.body) throw new client.ApiError(404, 'database secret', undefined, { code: 'ASSESSMENT_NOT_AVAILABLE' });
      return path.endsWith('/attempts') ? { attempts: [] } : { quiz: { title: 'React quiz', questions: [{ prompt: 'Choose one', options: ['First', 'Second'] }] } };
    });
    await renderPage(<QuizPage courseId="course-1" quizId="quiz-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /start quiz/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit quiz' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'View course' })).toHaveAttribute('href', '/courses/course-1');
    expect(screen.getByRole('radio', { name: 'Second' })).toBeChecked();
    expect(alert).not.toHaveTextContent(/database|secret/);
  });

  it('keeps assignment inputs and gives graded-lock guidance without retrying a submission', async () => {
    vi.spyOn(client, 'api').mockImplementation(async (path, opts) => {
      if (opts?.body) throw new client.ApiError(400, 'database secret', undefined, { code: 'ASSESSMENT_SUBMISSION_LOCKED' });
      return path.endsWith('/submissions') ? { submissions: [] } : { assignment: { title: 'React project', maxMarks: 100 } };
    });
    await renderPage(<AssignmentPage courseId="course-1" assignmentId="assignment-1" />);
    fireEvent.change(await screen.findByLabelText('Written answer (optional)'), { target: { value: 'My work' } });
    fireEvent.click(screen.getByRole('button', { name: /submit assignment/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/graded/i);
    expect(within(alert).getByRole('link', { name: 'Go to My Learning' })).toBeInTheDocument();
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Written answer (optional)')).toHaveValue('My work');
  });

  it('refreshes the grading queue after a stale review conflict', async () => {
    const request = vi.spyOn(client, 'api').mockImplementation(async (path, opts) => {
      if (opts?.body) throw new client.ApiError(400, 'database secret', undefined, { code: 'ASSESSMENT_REVIEW_CONFLICT' });
      return path.endsWith('/submissions') ? { submissions: [{ id: 'submission-1', status: 'SUBMITTED', version: 1 }] } : { assignments: [{ id: 'assignment-1', title: 'React project', maxMarks: 100 }] };
    });
    await renderPage(<InstructorPage section="submissions" courseId="course-1" />);
    fireEvent.change(await screen.findByLabelText('Marks (out of 100)'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Good work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grade' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/database|secret/);
    const reads = request.mock.calls.filter(([path, opts]) => path.endsWith('/submissions') && !opts?.body).length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Refresh assessment' }));
    await waitFor(() => expect(request.mock.calls.filter(([path, opts]) => path.endsWith('/submissions') && !opts?.body)).toHaveLength(reads + 1));
    expect(screen.getByLabelText('Feedback')).toHaveValue('Good work');
  });

  it('refreshes certificate requirements and offers course learning after an ineligible claim', async () => {
    let claimed = false;
    vi.spyOn(client, 'api').mockImplementation(async (path, opts) => {
      if (opts?.method === 'POST') { claimed = true; throw new client.ApiError(409, 'database secret', undefined, { code: 'CERTIFICATE_NOT_ELIGIBLE' }); }
      return path.endsWith('/eligibility') ? { eligibility: { eligible: !claimed, lecturePercent: claimed ? 40 : 100, lectureRequirementMet: !claimed, quizzesRequirementMet: true, assignmentsRequirementMet: false, assessmentAverage: 80, assessmentRequirementMet: true } } : { certificates: [] };
    });
    await renderPage(<StudentPage section="certificates" />);
    fireEvent.click(await screen.findByRole('button', { name: /claim certificate/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/lessons.*quizzes.*assignments/i);
    expect(within(alert).getByRole('link', { name: 'Continue learning' })).toHaveAttribute('href', '/learn/course-1');
    expect(await screen.findByText('40% completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim certificate/i })).not.toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/database|secret/);
  });

  it('shows permission recovery and preserves the live user row when role management is forbidden', async () => {
    session.role = 'ADMIN';
    vi.spyOn(adminApi, 'listAdminUsers').mockResolvedValue({ success: true, users: [{ id: 'target-user', name: 'Target user', email: 'target@example.test', avatar: null, role: 'STUDENT', createdAt: '' }], nextCursor: null });
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(<AdminPage section="roles" />);
    expect(await screen.findByText('Target user')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make instructor' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/permission/i);
    expect(within(alert).getByRole('link', { name: 'Go to admin workspace' })).toHaveAttribute('href', '/admin');
    expect(screen.getByText('Target user')).toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/database|secret/);
  });
});

describe('instructor course validation recovery', () => {
  it('uses the authenticated instructor workspace for a forbidden course mutation', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN' }));
    await renderPage(<InstructorPage section="create" />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Learning React' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Course description' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Development' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create course' }));
    expect(within(await screen.findByRole('alert')).getByRole('link', { name: 'Go to instructor workspace' })).toHaveAttribute('href', '/instructor');
  });
  it('provides native title length validation and preserves an approved backend constraint with entered values', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(422, 'Title must be atleast 8 char', undefined, { code: 'COURSE_INVALID_REQUEST' }));
    await renderPage(<InstructorPage section="create" />);
    const title = screen.getByLabelText('Title');
    expect(title).toHaveAttribute('minlength', '8');
    fireEvent.change(title, { target: { value: 'Learning React' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Course description' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Development' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create course' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Title must be atleast 8 char');
    expect(title).toHaveValue('Learning React');
  });

  it('never displays unrecognized course validation internals in the form', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(422, 'MongoDB secret stack', undefined, { code: 'COURSE_INVALID_REQUEST' }));
    await renderPage(<InstructorPage section="create" />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Learning React' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Course description' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Development' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create course' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Check the course details and try again.');
    expect(alert).not.toHaveTextContent(/MongoDB|secret|stack/);
  });
});

describe('student per-course assessment recovery', () => {
  it('uses the authenticated student workspace for a forbidden assessment query', async () => {
    session.role = 'STUDENT';
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN' }));
    await renderPage(<StudentPage section="assessments" />);
    expect(within(await screen.findByRole('alert')).getByRole('link', { name: 'Go to My Learning' })).toHaveAttribute('href', '/student/my-learning');
  });
  it.each(['quizzes', 'assignments'])('offers the correct course action for a failed %s query', async failedList => {
    vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path.endsWith(`/${failedList}`)) throw new client.ApiError(403, 'private enrollment details', undefined, { code: 'COURSE_PURCHASE_REQUIRED' });
      return { quizzes: [], assignments: [] };
    });
    await renderPage(<StudentPage section="assessments" />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'View course' })).toHaveAttribute('href', '/courses/course-1');
    expect(alert).not.toHaveTextContent(/private|enrollment details/);
    expect(within(alert).queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('keeps revoked access recovery separate from purchase or retry advice', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(new client.ApiError(403, 'private details', undefined, { code: 'COURSE_ACCESS_REVOKED' }));
    await renderPage(<StudentPage section="assessments" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/revoked/);
    expect(within(alert).getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', 'mailto:help@skillforge.example');
    expect(within(alert).queryByRole('link', { name: 'View course' })).not.toBeInTheDocument();
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('retries both assessment queries safely and restores quiz and assignment cards', async () => {
    let failing = true;
    const request = vi.spyOn(client, 'api').mockImplementation(async path => {
      if (failing) throw new Error('MongoDB secret stack');
      return path.endsWith('/quizzes') ? { quizzes: [{ _id: 'quiz-1', title: 'React quiz', passMark: 80 }] } : { assignments: [{ _id: 'assignment-1', title: 'React project', maxMarks: 100 }] };
    });
    await renderPage(<StudentPage section="assessments" />);
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/MongoDB|secret|stack/);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('React quiz')).toBeInTheDocument();
    expect(await screen.findByText('React project')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /take quiz/i })).toHaveAttribute('href', '/quizzes/course-1/quiz-1');
    expect(screen.getByRole('link', { name: /view assignment/i })).toHaveAttribute('href', '/assignments/course-1/assignment-1');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains the empty-course assessment message', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ quizzes: [], assignments: [] });
    await renderPage(<StudentPage section="assessments" />);
    expect(await screen.findByText('No published assessments for this course yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
