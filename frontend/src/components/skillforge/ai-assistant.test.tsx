import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningCompass } from './ai-assistant';
import { ApiError } from '@/lib/api/client';
import { presentApiError } from '@/lib/errors/present';

vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { id: 'session-student', role: 'STUDENT' }, status: 'authenticated' }) }));

const profile = { careerGoal: 'Web developer', interests: ['web'], selfReportedSkills: [], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 };
const complete = { success: true, profile, missingFields: [] };
const missing = { success: true, profile: null, missingFields: ['careerGoal', 'interests', 'experienceLevel', 'weeklyAvailabilityHours'] };
const recommendations = [
  { course: { id: '111111111111111111111111', title: 'Web foundations', description: 'Build a foundation.', category: 'Web', accessType: 'FREE', price: 0, currency: 'INR', thumbnailUrl: null, level: 'BEGINNER', skills: ['html'] }, score: 83, signals: { interestCategoryMatch: 30, goalKeywordMatch: 11, skillMatch: 7, levelFit: 15, prerequisiteFit: 20 }, unmetPrerequisites: [] },
  { course: { id: '222222222222222222222222', title: 'Accessible interfaces', description: 'Design for everyone.', category: 'Web', accessType: 'PAID', price: 129900, currency: 'INR', thumbnailUrl: 'https://example.com/cover.jpg', level: 'INTERMEDIATE', skills: ['a11y'] }, score: 61, signals: { interestCategoryMatch: 30, goalKeywordMatch: 8, skillMatch: 15, levelFit: 8, prerequisiteFit: 0 }, unmetPrerequisites: ['Complete the required prerequisite course'] },
  { course: { id: '333333333333333333333333', title: 'Browser skills', description: 'Explore the browser.', category: 'Web', accessType: 'FREE', price: 0, currency: 'INR', thumbnailUrl: null, level: null, skills: [] }, score: 59, signals: { interestCategoryMatch: 0, goalKeywordMatch: 9, skillMatch: 15, levelFit: 15, prerequisiteFit: 20 }, unmetPrerequisites: [] },
];
const active = { course: { id: '444444444444444444444444', title: 'Learning React', category: 'Web' }, progress: { totalLectures: 8, completedLectures: 3, completionPercent: 38 }, nextLecture: { id: '555555555555555555555555', title: 'Components in practice' }, assessments: { totalQuizzes: 0, totalAssignments: 0, quizzes: [], assignments: [] }, certificate: null };
const certificateEligibility = { eligible: false, totalLectures: 8, completedLectures: 3, lecturePercent: 37.5,
  requiredQuizzes: 1, passedQuizzes: 0, requiredAssignments: 2, gradedAssignments: 1, assessmentAverage: 60,
  lectureRequirementMet: false, quizzesRequirementMet: false, assignmentsRequirementMet: false, assessmentRequirementMet: false };
const clients: QueryClient[] = [];
type Request = { path: string; init: RequestInit; body: any };
function server(overrides: (request: Request) => unknown = () => undefined) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const request = { path: String(input).split('/api/v1')[1]!, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    const custom = await overrides(request);
    if (custom instanceof Response) return custom;
    const data = custom ?? (request.path === '/ai/profile' ? complete : request.path === '/ai/recommendations' ? { success: true, recommendations } : request.path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [] } } : undefined);
    if (!data) throw new Error(`Unexpected endpoint ${request.path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  return requests;
}
async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(qc);
  const root = createRootRoute({ component: LearningCompass });
  const routes = ['/', '/courses/$courseId', '/learn/$courseId', '/quizzes/$courseId/$quizId', '/assignments/$courseId/$assignmentId', '/student/$section'].map(path => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
  await act(async () => { await router.load(); });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}
afterEach(() => { cleanup(); clients.splice(0).forEach(qc => qc.clear()); vi.unstubAllGlobals(); });

describe('Grounded course materials tutor', () => {
  const materialId = '999999999999999999999999';
  const materialsPath = `/courses/${active.course.id}/materials`;
  const downloadEndpoint = `/api/v1${materialsPath}/${materialId}/download`;
  const material = { id: materialId, title: 'React study notes', lectureId: null, pageCount: 4, downloadEndpoint, storage: { key: 'private-secret' }, sourceText: 'hidden-source', embedding: [1, 2] };
  function tutorServer(overrides: (request: Request) => unknown = () => undefined) {
    return server(async request => (await overrides(request)) ?? (request.path === '/ai/guidance' ? { guidance: { activeCourses: [active] } }
      : request.path === materialsPath ? { materials: [material] }
        : request.path === `/courses/${active.course.id}` ? { course: { id: active.course.id, title: active.course.title, lectures: [active.nextLecture] } } : undefined));
  }
  async function selectCourse() {
    const picker = await screen.findByLabelText('Course for materials');
    await waitFor(() => expect(picker).toHaveTextContent('Learning React'));
    expect(picker).not.toHaveTextContent('Accessible interfaces');
    fireEvent.change(picker, { target: { value: active.course.id } });
    await screen.findByLabelText('Question about course materials');
  }
  it('uses a distinct active-course and lecture-scoped tutor, renders citations, and links only to the authenticated download endpoint', async () => {
    let finish!: (value: unknown) => void;
    const requests = tutorServer(({ path }) => path === '/ai/course-tutor' ? new Promise(resolve => { finish = resolve; }) : undefined);
    await mount(); await selectCourse();
    const panel = screen.getByRole('region', { name: 'Ask course materials' });
    const download = await within(panel).findByRole('link', { name: 'Download React study notes' });
    expect(download.getAttribute('href')).toMatch(new RegExp(`${downloadEndpoint}$`));
    expect(download).toHaveAttribute('target', '_blank'); expect(download).toHaveAttribute('rel', 'noreferrer');
    fireEvent.change(screen.getByLabelText('Lecture for materials'), { target: { value: active.nextLecture.id } });
    fireEvent.change(screen.getByLabelText('Question about course materials'), { target: { value: 'How do components compose?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    expect(await screen.findByRole('button', { name: /Reading materials/ })).toBeDisabled();
    await act(async () => finish({ tutor: { outcome: 'ANSWERED', answer: 'Components combine reusable pieces.', citations: [{ materialId, title: material.title, pageStart: 2, pageEnd: 3, sourceText: 'hidden-source' }], signedUrl: 'https://r2.example/secret' } }));
    expect(await within(panel).findByText('Components combine reusable pieces.')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Pages 2–3'); expect(panel).not.toHaveTextContent(/private-secret|hidden-source|r2.example/);
    expect(requests.find(r => r.path === '/ai/course-tutor')?.body).toEqual({ courseId: active.course.id, lectureId: active.nextLecture.id, question: 'How do components compose?' });
    expect(requests.every(r => r.init.credentials === 'include')).toBe(true);
    expect(requests.some(r => r.path.includes('/download'))).toBe(false);
    expect(requests.some(r => r.path === '/ai/chat')).toBe(false);
  });

  it('sends whole-course questions without lectureId and clears the answer after scope changes', async () => {
    const requests = tutorServer(({ path }) => path === '/ai/course-tutor' ? { tutor: { outcome: 'ANSWERED', answer: 'Whole course answer.', citations: [{ materialId, title: material.title, pageStart: 1, pageEnd: 1 }] } } : undefined);
    await mount(); await selectCourse();
    fireEvent.change(screen.getByLabelText('Question about course materials'), { target: { value: 'Explain the topic.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    await screen.findByText('Whole course answer.');
    expect(requests.find(r => r.path === '/ai/course-tutor')?.body).toEqual({ courseId: active.course.id, question: 'Explain the topic.' });
    fireEvent.change(screen.getByLabelText('Lecture for materials'), { target: { value: active.nextLecture.id } });
    expect(screen.queryByText('Whole course answer.')).not.toBeInTheDocument();
  });

  it('explains an empty materials list without requesting a tutor or suggesting a purchase', async () => {
    const requests = tutorServer(({ path }) => path === materialsPath ? { materials: [] } : undefined);
    await mount(); await selectCourse();
    const panel = screen.getByRole('region', { name: 'Ask course materials' });
    expect(await within(panel).findByText(/No published PDF study material/i)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/purchase|buy|enroll/i);
    expect(screen.getByRole('button', { name: 'Ask materials tutor' })).toBeDisabled();
    expect(requests.some(r => r.path === '/ai/course-tutor')).toBe(false);
  });

  it('does not show a delayed answer from the previous lecture scope', async () => {
    let finish!: (value: unknown) => void;
    tutorServer(({ path }) => path === '/ai/course-tutor' ? new Promise(resolve => { finish = resolve; }) : undefined);
    await mount(); await selectCourse();
    fireEvent.change(screen.getByLabelText('Question about course materials'), { target: { value: 'Whole course question.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    await screen.findByRole('button', { name: /Reading materials/ });
    fireEvent.change(screen.getByLabelText('Lecture for materials'), { target: { value: active.nextLecture.id } });
    await act(async () => finish({ tutor: { outcome: 'ANSWERED', answer: 'Old scope response.', citations: [{ materialId, title: material.title, pageStart: 1, pageEnd: 1 }] } }));
    expect(screen.queryByText('Old scope response.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Question about course materials')).toHaveValue('');
  });

  it.each([
    ['NO_RELEVANT_SOURCE', /could not find.*published material/i],
    ['RAG_UNAVAILABLE', /temporarily unavailable/i],
    ['RAG_LIMIT_REACHED', /daily.*limit/i],
  ])('shows safe actionable %s copy instead of provider text', async (outcome, expected) => {
    tutorServer(({ path }) => path === '/ai/course-tutor' ? { tutor: { outcome, answer: 'raw-provider-secret', citations: [] } } : undefined);
    await mount(); await selectCourse();
    fireEvent.change(screen.getByLabelText('Question about course materials'), { target: { value: 'Explain components.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    const panel = screen.getByRole('region', { name: 'Ask course materials' });
    expect(await within(panel).findByText(expected)).toBeInTheDocument(); expect(panel).not.toHaveTextContent('raw-provider-secret');
  });
});

describe('Learning compass and safe API hooks', () => {
  it('collects only the server missing fields one at a time and saves a complete first profile with cookie auth', async () => {
    const requests = server(({ path, init }) => path === '/ai/profile' ? init.method === 'PUT' ? complete : missing : undefined);
    await mount();
    const goal = await screen.findByLabelText('Career goal');
    expect(screen.queryByLabelText('Interests')).not.toBeInTheDocument();
    fireEvent.change(goal, { target: { value: 'Web developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const interests = screen.getByLabelText('Interests');
    expect(interests).toHaveFocus();
    fireEvent.change(interests, { target: { value: 'web, design' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Experience level'), { target: { value: 'BEGINNER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Weekly availability (hours)'), { target: { value: '4' } });
    expect(requests.filter(r => r.init.method === 'PUT')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save learning profile' }));
    await screen.findByText('Web foundations');
    const writes = requests.filter(r => r.init.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ careerGoal: 'Web developer', interests: ['web', 'design'], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 });
    expect(requests.every(r => r.init.credentials === 'include')).toBe(true);
    expect(requests.every(r => !/studentId|model|provider/i.test(JSON.stringify(r.body ?? {})))).toBe(true);
  });

  it('uses the server missing-field list for an existing partial profile', async () => {
    server(({ path }) => path === '/ai/profile' ? { success: true, profile: { ...profile, interests: [] }, missingFields: ['interests'] } : undefined);
    await mount();
    expect(await screen.findByLabelText('Interests')).toBeInTheDocument();
    expect(screen.queryByLabelText('Career goal')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save learning profile' })).toBeInTheDocument();
  });

  it('renders actual free and paid cards in server order with exact score signals and course links only', async () => {
    server(); await mount();
    await screen.findByRole('article', { name: 'Web foundations' });
    const cards = screen.getAllByRole('article');
    expect(cards.map(card => within(card).getByRole('heading').textContent)).toEqual(['Web foundations', 'Accessible interfaces', 'Browser skills']);
    const paid = screen.getByRole('article', { name: 'Accessible interfaces' });
    expect(paid).toHaveTextContent('Paid'); expect(paid).toHaveTextContent('₹1,299');
    expect(paid).toHaveTextContent('Match score: 61/100');
    expect(paid).toHaveTextContent('Interest match: 30'); expect(paid).toHaveTextContent('Goal match: 8');
    expect(paid).toHaveTextContent('Skill match: 15'); expect(paid).toHaveTextContent('Level fit: 8'); expect(paid).toHaveTextContent('Prerequisite fit: 0');
    expect(paid).toHaveTextContent('Complete the required prerequisite course');
    expect(screen.getByRole('article', { name: 'Web foundations' })).toHaveTextContent('Free');
    expect(screen.getAllByRole('link', { name: 'View course' }).map(link => link.getAttribute('href'))).toEqual(['/courses/111111111111111111111111', '/courses/222222222222222222222222', '/courses/333333333333333333333333']);
    expect(screen.queryByRole('button', { name: /buy|purchase|enroll/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/SkillForge instructor|0 lessons/)).not.toBeInTheDocument();
  });

  it('renders server progress and next lesson without computing completion or eligibility', async () => {
    server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active] } } : undefined);
    await mount();
    expect(await screen.findByText('Components in practice')).toBeInTheDocument();
    expect(screen.getByText(/38% complete/)).toHaveTextContent('3 of 8 lessons');
    const nextLink = new URL(screen.getByRole('link', { name: 'Open next lesson' }).getAttribute('href')!, 'http://localhost');
    expect(nextLink.pathname).toBe('/learn/444444444444444444444444');
    // TanStack quotes numeric-looking string IDs to preserve their string type.
    expect(JSON.parse(nextLink.searchParams.get('lecture')!)).toBe('555555555555555555555555');
    expect(screen.getByText('Progress', { exact: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Course for guidance')).toHaveTextContent('Learning React');
    expect(screen.getByLabelText('Course for guidance')).not.toHaveTextContent('Accessible interfaces');
  });

  it('does not show skill or level match evidence for metadata-free recommendations', async () => {
    server(); await mount();
    const card = await screen.findByRole('article', { name: 'Browser skills' });
    expect(card).not.toHaveTextContent('Skill match');
    expect(card).not.toHaveTextContent('Level fit');
  });

  it('renders safe assessment statuses and remaining certificate requirements from guidance', async () => {
    const assessments = { totalQuizzes: 1, totalAssignments: 2,
      quizzes: [{ id: '666666666666666666666666', title: 'React quiz', passMark: 80, bestPercentage: 50, passed: false }],
      assignments: [{ id: '777777777777777777777777', title: 'React project', dueDate: null, maxMarks: 100, status: 'SUBMITTED', marks: null },
        { id: '888888888888888888888888', title: 'Practice task', dueDate: null, maxMarks: 100, status: 'GRADED', marks: 90 }] };
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [{ ...active, assessments, certificateEligibility }] } } : undefined);
    await mount();
    expect(await screen.findByText(/Certificate requirements remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Quizzes passed: 0 of 1/)).toBeInTheDocument();
    expect(screen.getByText(/Assignments graded: 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/Assessment average: 60%/)).toBeInTheDocument();
    expect(screen.getByText(/Not passed.*50%/)).toBeInTheDocument();
    expect(screen.getByText(/Awaiting review/)).toBeInTheDocument();
    expect(screen.getByText(/Graded.*90.*100/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'React quiz' })).toHaveAttribute('href', '/quizzes/444444444444444444444444/666666666666666666666666');
    expect(screen.getByRole('link', { name: 'React project' })).toHaveAttribute('href', '/assignments/444444444444444444444444/777777777777777777777777');
    expect(screen.getByRole('link', { name: 'Review certificates' })).toHaveAttribute('href', '/student/certificates');
    expect(requests.every(request => !request.init.method || request.init.method === 'GET')).toBe(true);
  });

  it.each([
    [null, 'Certificate ready to claim'],
    [{ certificateNumber: 'LMS-2026-AAAAAAAAAAAAAAAAAAAA', issuedAt: '2026-10-27T00:00:00.000Z' }, 'Certificate issued'],
  ])('renders the server certificate state %s from a chat guidance response', async (certificate, expected) => {
    server(({ path }) => path === '/ai/chat' ? { success: true, assistant: { message: 'Review your certificate guidance.', grounding: 'PROGRESS',
      guidance: { activeCourses: [{ ...active, certificate, certificateEligibility: { ...certificateEligibility, eligible: true } }] } } } : undefined);
    await mount();
    fireEvent.change(await screen.findByLabelText('Ask for guidance'), { target: { value: 'Certificate status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText(String(expected))).toBeInTheDocument();
    expect(screen.queryByText('Certificate requirements remaining')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim certificate/i })).not.toBeInTheDocument();
  });

  it('sends an explicitly selected active course and displays only the returned server reply and grounding', async () => {
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active] } } : path === '/ai/chat' ? { success: true, assistant: { message: 'Your next recorded lesson is Components in practice.', grounding: 'PROGRESS', guidance: { activeCourses: [active] } } } : undefined);
    await mount(); await screen.findByLabelText('Ask for guidance');
    fireEvent.change(screen.getByLabelText('Course for guidance'), { target: { value: active.course.id } });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'What is my next lesson?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText('Your next recorded lesson is Components in practice.')).toBeInTheDocument();
    expect(requests.find(r => r.path === '/ai/chat')!.body).toEqual({ message: 'What is my next lesson?', courseId: active.course.id });
    expect(screen.getByLabelText('Ask for guidance')).toHaveValue('');
  });

  it('review: renders chat-returned progress after a failed guidance read without adding course-selection options', async () => {
    const requests = server(({ path }) => path === '/ai/guidance' ? new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE' } }), { status: 503 }) : path === '/ai/chat' ? { success: true, assistant: { message: 'Here is your recorded next lesson.', grounding: 'PROGRESS', guidance: { activeCourses: [active] } } } : undefined);
    await mount();
    fireEvent.change(await screen.findByLabelText('Ask for guidance'), { target: { value: 'What is my next lesson?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText('Here is your recorded next lesson.')).toBeInTheDocument();
    expect(screen.getByText('Components in practice')).toBeInTheDocument();
    expect(screen.getByText(/38% complete/)).toHaveTextContent('3 of 8 lessons');
    expect(screen.getByRole('link', { name: 'Open next lesson' })).toHaveAttribute('href', expect.stringContaining('/learn/444444444444444444444444?lecture='));
    expect(screen.queryByLabelText('Course for guidance')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Help me plan my week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await waitFor(() => expect(requests.filter(request => request.path === '/ai/chat')).toHaveLength(2));
    expect(requests.filter(request => request.path === '/ai/chat').map(request => request.body)).toEqual([{ message: 'What is my next lesson?' }, { message: 'Help me plan my week' }]);
  });

  it('review: displays chat guidance without letting it expand the read-authorized course choices', async () => {
    const otherActive = { ...active, course: { ...active.course, id: '666666666666666666666666', title: 'Another recorded course' }, nextLecture: { id: '777777777777777777777777', title: 'A different next lesson' } };
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active] } } : path === '/ai/chat' ? { success: true, assistant: { message: 'Review the returned course guidance.', grounding: 'PROGRESS', guidance: { activeCourses: [otherActive] } } } : undefined);
    await mount();
    const picker = await screen.findByLabelText('Course for guidance');
    fireEvent.change(picker, { target: { value: active.course.id } });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Show guidance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await screen.findByText('Review the returned course guidance.');
    expect(screen.getByText('A different next lesson')).toBeInTheDocument();
    expect(within(picker).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['', '444444444444444444444444']);
    fireEvent.change(picker, { target: { value: otherActive.course.id } });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Show another direction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await waitFor(() => expect(requests.filter(request => request.path === '/ai/chat')).toHaveLength(2));
    expect(requests.filter(request => request.path === '/ai/chat')[1]!.body).toEqual({ message: 'Show another direction' });
  });

  it('review: displays the returned catalog cards and score signals when a chat succeeds', async () => {
    const returnedCard = { ...recommendations[1], course: { ...recommendations[1]!.course, title: 'Catalog direction from chat' }, score: 57, signals: { interestCategoryMatch: 30, goalKeywordMatch: 4, skillMatch: 15, levelFit: 8, prerequisiteFit: 0 } };
    server(({ path }) => path === '/ai/chat' ? { success: true, assistant: { message: 'Consider this published course.', grounding: 'CATALOG', recommendations: [returnedCard] } } : undefined);
    await mount();
    await screen.findByRole('article', { name: 'Web foundations' });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Help me choose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await screen.findByText('Consider this published course.');
    const card = screen.getByRole('article', { name: 'Catalog direction from chat' });
    expect(card).toHaveTextContent('Paid'); expect(card).toHaveTextContent('₹1,299');
    expect(card).toHaveTextContent('Match score: 57/100'); expect(card).toHaveTextContent('Goal match: 4');
    expect(within(card).getByRole('link', { name: 'View course' })).toHaveAttribute('href', '/courses/222222222222222222222222');
    expect(screen.queryByRole('button', { name: /buy|purchase|enroll/i })).not.toBeInTheDocument();
  });

  it('review: moves focus into the completed panel and announces profile success after the final server save', async () => {
    server(({ path, init }) => path === '/ai/profile' ? init.method === 'PUT' ? complete : { success: true, profile, missingFields: ['weeklyAvailabilityHours'] } : path === '/ai/recommendations' ? new Promise(() => {}) : undefined);
    await mount();
    const hours = await screen.findByLabelText('Weekly availability (hours)');
    fireEvent.change(hours, { target: { value: '6' } });
    const save = screen.getByRole('button', { name: 'Save learning profile' });
    save.focus();
    expect(save).toHaveFocus();
    fireEvent.click(save);
    const destination = await screen.findByRole('heading', { name: 'Courses to explore' });
    await waitFor(() => expect(destination).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent(/learning profile.*ready/i);
    expect(screen.queryByLabelText('Weekly availability (hours)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading course matches')).toBeInTheDocument();
  });

  it('shows the content boundary and server metadata-only answer without implying video access', async () => {
    server(({ path }) => path === '/ai/chat' ? { success: true, assistant: { message: 'I can use course structure and recorded progress, but cannot read lesson content or watch videos.', grounding: 'COURSE_METADATA' } } : undefined);
    await mount(); await screen.findByLabelText('Ask for guidance');
    expect(screen.getByText(/metadata only/i)).toHaveTextContent(/cannot.*lesson content.*videos/i);
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Explain the next video' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText('I can use course structure and recorded progress, but cannot read lesson content or watch videos.')).toBeInTheDocument();
    expect(screen.getAllByText('Course structure', { exact: true }).length).toBeGreaterThan(0);
  });

  it('shows loading before profile data exists', async () => {
    server(() => new Promise(() => {})); await mount();
    expect(screen.getByLabelText('Loading learning compass')).toBeInTheDocument();
    expect(screen.queryByLabelText('Career goal')).not.toBeInTheDocument();
  });

  it('retries a safe initial error without exposing diagnostic text', async () => {
    let failed = true;
    server(({ path }) => path === '/ai/profile' && failed ? new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE', message: 'provider api_key=secret' } }), { status: 503 }) : undefined);
    await mount(); const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/provider|secret|api_key/);
    failed = false; fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Web foundations')).toBeInTheDocument();
  });

  it('preserves the question on failure and retries only on explicit submission while keeping catalog guidance', async () => {
    let failed = true;
    const requests = server(({ path }) => path === '/ai/chat' ? failed ? new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE', message: 'raw sensitive error' } }), { status: 503 }) : { success: true, assistant: { message: 'Review the published courses and their match signals.', grounding: 'CATALOG', recommendations } } : undefined);
    await mount(); await screen.findByLabelText('Ask for guidance');
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Help me choose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    const alert = await screen.findByRole('alert'); expect(alert).not.toHaveTextContent(/raw|sensitive/);
    expect(screen.getByLabelText('Ask for guidance')).toHaveValue('Help me choose');
    expect(screen.getByText('Web foundations')).toBeInTheDocument();
    expect(requests.filter(r => r.path === '/ai/chat')).toHaveLength(1);
    failed = false; fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Review the published courses and their match signals.')).toBeInTheDocument();
    expect(requests.filter(r => r.path === '/ai/chat')).toHaveLength(2);
    expect(requests.filter(r => r.path === '/ai/chat').every(r => Object.keys(r.body).join() === 'message')).toBe(true);
  });

  it('retains profile answers after a failed save', async () => {
    server(({ path, init }) => path === '/ai/profile' ? init.method === 'PUT' ? new Response(JSON.stringify({ error: { code: 'AI_PROFILE_INVALID', message: 'internal database details' } }), { status: 400 }) : { success: true, profile, missingFields: ['weeklyAvailabilityHours'] } : undefined);
    await mount(); fireEvent.change(await screen.findByLabelText('Weekly availability (hours)'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save learning profile' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/internal|database/);
    expect(screen.getByLabelText('Weekly availability (hours)')).toHaveValue(6);
  });

  it('does not post blank or oversized questions and disables duplicate in-flight asks', async () => {
    const requests = server(({ path }) => path === '/ai/chat' ? new Promise(() => {}) : undefined);
    await mount(); const question = await screen.findByLabelText('Ask for guidance');
    expect(screen.getByRole('button', { name: 'Ask for guidance' })).toBeDisabled();
    expect(question).toHaveAttribute('maxlength', '2000');
    fireEvent.change(question, { target: { value: 'What next?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Asking…' })).toBeDisabled());
    expect(requests.filter(r => r.path === '/ai/chat')).toHaveLength(1);
  });
});

describe('safe AI error presentation', () => {
  it.each([
    [503, 'AI_UNAVAILABLE', /learning assistant.*temporarily unavailable/i, true],
    [400, 'AI_PROFILE_INVALID', /learning profile/i, false],
    [400, 'AI_CHAT_INVALID', /2000/i, false],
    [403, 'AI_ENROLLMENT_REQUIRED', /active.*course/i, false],
  ] as const)('maps %s %s without server diagnostics', (status, code, expected, retryable) => {
    const shown = presentApiError(new ApiError(status, 'provider-secret diagnostic', undefined, { code }), { returnTo: '/dashboard' });
    expect(shown.message).toMatch(expected); expect(shown.message).not.toContain('provider-secret'); expect(shown.retryable).toBe(retryable);
  });
});
