import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningCompass } from './ai-assistant';
import { ApiError } from '@/lib/api/client';
import { presentApiError } from '@/lib/errors/present';
import type { StudyPlanSession } from '@/lib/api/models';

vi.mock('@/lib/api/auth', () => ({ useAuth: () => ({ user: { id: 'session-student', role: 'STUDENT' }, status: 'authenticated' }) }));

const profile = { careerGoal: 'Web developer', interests: ['web'], selfReportedSkills: [], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 };
const complete = { success: true, profile, missingFields: [] };
const missing = { success: true, profile: null, missingFields: ['careerGoal', 'interests', 'experienceLevel', 'weeklyAvailabilityHours'] };
const recommendations = [
  { course: { id: '111111111111111111111111', title: 'Web foundations', description: 'Build a foundation.', category: 'Web', accessType: 'FREE', price: 0, currency: 'INR', thumbnailUrl: null, level: 'BEGINNER', skills: ['html'] }, score: 83, signals: { interestCategoryMatch: 30, goalKeywordMatch: 11, skillMatch: 7, levelFit: 15, prerequisiteFit: 20 }, pathwayOrder: 1, matchReasons: ['Matches your career goal'], prerequisites: { courses: [], skills: [] }, unmetPrerequisites: [] },
  { course: { id: '222222222222222222222222', title: 'Accessible interfaces', description: 'Design for everyone.', category: 'Web', accessType: 'PAID', price: 129900, currency: 'INR', thumbnailUrl: 'https://example.com/cover.jpg', level: 'INTERMEDIATE', skills: ['a11y'] }, score: 61, signals: { interestCategoryMatch: 30, goalKeywordMatch: 8, skillMatch: 15, levelFit: 8, prerequisiteFit: 0 }, pathwayOrder: 2, matchReasons: ['Aligns with your interests', 'Has prerequisites to confirm or complete'], prerequisites: { courses: [{ id: '111111111111111111111111', title: 'Web foundations', status: 'AVAILABLE' }], skills: [{ skill: 'a11y', status: 'NEEDS_SKILL' }] }, unmetPrerequisites: ['Complete prerequisite course: Web foundations'] },
  { course: { id: '333333333333333333333333', title: 'Browser skills', description: 'Explore the browser.', category: 'Web', accessType: 'FREE', price: 0, currency: 'INR', thumbnailUrl: null, level: null, skills: [] }, score: 59, signals: { interestCategoryMatch: 0, goalKeywordMatch: 9, skillMatch: 15, levelFit: 15, prerequisiteFit: 20 }, pathwayOrder: 3, matchReasons: ['Matches your career goal'], prerequisites: { courses: [], skills: [] }, unmetPrerequisites: [] },
];
const active = { course: { id: '444444444444444444444444', title: 'Learning React', category: 'Web' }, progress: { totalLectures: 8, completedLectures: 3, completionPercent: 38 }, lastActivityAt: '2026-10-10T12:00:00.000Z', activityStatus: 'PAUSED' as const, nextLecture: { id: '555555555555555555555555', title: 'Components in practice' }, assessments: { totalQuizzes: 0, totalAssignments: 0, quizzes: [], assignments: [] }, certificate: null };
const recap = { courseCount: 1, completedLessons: 3, totalLessons: 8, upcomingWork: [
  { id: '666666666666666666666666', courseId: active.course.id, courseTitle: active.course.title, kind: 'ASSIGNMENT' as const, title: 'Build a component', dueAt: '2026-11-05T12:00:00.000Z' },
  { id: '777777777777777777777777', courseId: active.course.id, courseTitle: active.course.title, kind: 'QUIZ' as const, title: 'Component quiz', dueAt: null },
] };
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
    const query = new URLSearchParams(request.path.split('?')[1] ?? '');
    const period = request.body ?? { startDate: query.get('startDate'), timeZone: query.get('timeZone') };
    const emptyPlan = { weekStart: period.startDate ?? '2026-11-02', timeZone: period.timeZone ?? 'UTC', availableMinutes: 240, plannedMinutes: 0, message: 'No incomplete lessons or upcoming published assessments were found for your active courses.', sessions: [] };
    const data = custom ?? (request.path === '/ai/profile' ? complete : request.path === '/ai/recommendations' ? { success: true, recommendations } : request.path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [] } }
      : request.path.startsWith('/ai/study-plan?') ? { success: true, plan: null, preview: emptyPlan }
        : request.path === '/ai/study-plan/preview' ? { success: true, preview: emptyPlan } : undefined);
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
    return server(async request => (await overrides(request)) ?? (request.path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active], recap } }
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
  it('shows backend progress totals, upcoming published work links, and a neutral 14-day support nudge', async () => {
    server(({ path }) => path === '/ai/guidance'
      ? { success: true, guidance: { activeCourses: [active], recap } } : undefined);
    await mount();
    const recapPanel = await screen.findByRole('region', { name: 'Progress recap' });
    expect(recapPanel).toHaveTextContent('3 of 8 lessons across these 1 active courses');
    expect(screen.getByText(/no recorded lesson activity here for at least 14 days/i)).toBeInTheDocument();
    const assignment = within(recapPanel).getByRole('link', { name: 'Build a component' });
    expect(assignment.getAttribute('href')).toContain(`/assignments/${active.course.id}/${recap.upcomingWork[0].id}`);
    expect(within(recapPanel).getByRole('link', { name: 'Component quiz' }).getAttribute('href'))
      .toContain(`/quizzes/${active.course.id}/${recap.upcomingWork[1].id}`);
    expect(recapPanel).toHaveTextContent(/Due/);
    expect(recapPanel).not.toHaveTextContent(/at risk|behind|failing/i);
  });

  it('does not call a learner with no recorded activity stalled', async () => {
    server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: {
      activeCourses: [{ ...active, lastActivityAt: null, activityStatus: 'NOT_STARTED' }],
      recap: { courseCount: 1, completedLessons: 0, totalLessons: 8, upcomingWork: [] },
    } } : undefined);
    await mount();
    expect(await screen.findByRole('region', { name: 'Progress recap' })).toHaveTextContent('0 of 8 lessons');
    expect(screen.queryByText(/no recorded lesson activity here for at least 14 days/i)).not.toBeInTheDocument();
    expect(screen.getByText('Components in practice')).toBeInTheDocument();
  });

  it('presents completed courses as complete rather than paused', async () => {
    server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: {
      activeCourses: [{ ...active, progress: { totalLectures: 8, completedLectures: 8, completionPercent: 100 },
        lastActivityAt: '2026-09-01T12:00:00.000Z', activityStatus: 'COMPLETE', nextLecture: null }],
      recap: { courseCount: 1, completedLessons: 8, totalLessons: 8, upcomingWork: [] },
    } } : undefined);
    await mount();
    expect(await screen.findByText('You have completed all available lessons in this course.')).toBeInTheDocument();
    expect(screen.queryByText(/no recorded lesson activity here for at least 14 days/i)).not.toBeInTheDocument();
  });

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

  it('sends the optional plain-English style without changing course or citation scope', async () => {
    const requests = tutorServer(({ path }) => path === '/ai/course-tutor'
      ? { tutor: { outcome: 'ANSWERED', answer: 'A variable stores a value.', citations: [{ materialId, title: material.title, pageStart: 1, pageEnd: 1 }] } }
      : path === '/ai/course-practice' ? { success: true, practice: { outcome: 'PRACTICE_READY', message: '',
        questions: [{ prompt: 'What does a variable store?', choices: ['A value', 'A lesson plan', 'A page number', 'A course image'],
          correctIndex: 0, explanation: 'A variable stores a value.', citations: [{ materialId, title: material.title, pageStart: 1, pageEnd: 1 }] }] } }
        : undefined);
    await mount(); await selectCourse();
    const plainLanguageControls = screen.getAllByLabelText('Use plain English with shorter sentences and simpler words');
    fireEvent.click(plainLanguageControls[1]);
    fireEvent.change(screen.getByLabelText('Question about course materials'), { target: { value: 'What is a variable?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    expect(await screen.findByText('A variable stores a value.')).toBeInTheDocument();
    expect(requests.find(request => request.path === '/ai/course-tutor')?.body).toEqual({
      courseId: active.course.id, question: 'What is a variable?', plainLanguage: true
    });

    fireEvent.click(plainLanguageControls[0]);
    fireEvent.change(screen.getByLabelText('Topic to practice'), { target: { value: 'Variables' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate practice questions' }));
    const practice = screen.getByRole('region', { name: 'Practice from published PDFs' });
    expect(await within(practice).findByText(/What does a variable store/)).toBeInTheDocument();
    expect(requests.find(request => request.path === '/ai/course-practice')?.body).toEqual({
      courseId: active.course.id, topic: 'Variables', plainLanguage: true
    });
    expect(within(practice).getByRole('group', { name: /What does a variable store/ })).toBeInTheDocument();
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

  it('creates an ungraded PDF-grounded practice set and reveals answers only after the student checks them', async () => {
    const requests = tutorServer(({ path }) => path === '/ai/course-practice' ? { success: true, practice: {
      outcome: 'PRACTICE_READY',
      message: 'provider copy must not replace the safe rendering',
      questions: [{
        prompt: 'What do components help organize?',
        choices: ['Reusable interface pieces', 'Payment records', 'Course enrollments', 'PDF storage keys'],
        correctIndex: 0,
        explanation: 'The cited notes describe components as reusable interface pieces.',
        citations: [{ materialId, title: material.title, pageStart: 2, pageEnd: 3, sourceText: 'hidden-source' }],
        raw: 'private-provider-metadata',
      }],
    } } : undefined);
    await mount(); await selectCourse();
    const topic = await screen.findByLabelText('Topic to practice');
    fireEvent.change(topic, { target: { value: 'React components' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate practice questions' }));
    const practice = screen.getByRole('region', { name: 'Practice from published PDFs' });
    await waitFor(() => expect(requests.some(request => request.path === '/ai/course-practice')).toBe(true));
    expect(await within(practice).findByText(/What do components help organize\?/)).toBeInTheDocument();
    expect(screen.queryByText(/cited notes describe/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check answers' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Reusable interface pieces'));
    fireEvent.click(screen.getByRole('button', { name: 'Check answers' }));
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(within(practice).getAllByRole('status').some(status => status.textContent?.includes('Correct'))).toBe(true);
    expect(screen.getByText('The cited notes describe components as reusable interface pieces.')).toBeInTheDocument();
    expect(screen.getByText(/Pages 2–3/)).toBeInTheDocument();
    expect(practice).not.toHaveTextContent(/hidden-source|private-provider-metadata/);
    expect(requests.find(request => request.path === '/ai/course-practice')?.body).toEqual({ courseId: active.course.id, topic: 'React components' });
    expect(requests.every(request => request.init.credentials === 'include')).toBe(true);
    expect(requests.some(request => /quiz-attempt|progress|submission/.test(request.path))).toBe(false);
  });

  it.each([
    ['NO_RELEVANT_SOURCE', /not enough relevant information/i],
    ['RAG_UNAVAILABLE', /temporarily unavailable/i],
    ['RAG_LIMIT_REACHED', /practice-question limit/i],
  ])('shows safe practice fallback copy for %s', async (outcome, expected) => {
    const requests = tutorServer(({ path }) => path === '/ai/course-practice' ? { success: true, practice: {
      outcome, message: 'raw provider diagnostics', questions: [],
    } } : undefined);
    await mount(); await selectCourse();
    fireEvent.change(await screen.findByLabelText('Topic to practice'), { target: { value: 'React components' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate practice questions' }));
    const practice = screen.getByRole('region', { name: 'Practice from published PDFs' });
    expect(await within(practice).findByText(expected)).toBeInTheDocument();
    expect(practice).not.toHaveTextContent(/raw provider diagnostics/);
    expect(requests.some(request => request.path === '/ai/course-practice')).toBe(true);
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
    await screen.findByRole('heading', { name: 'Web foundations' });
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
    const requests = server(); await mount();
    await screen.findByRole('article', { name: 'Web foundations' });
    const cards = screen.getAllByRole('article');
    expect(cards.map(card => within(card).getByRole('heading').textContent)).toEqual(['Web foundations', 'Accessible interfaces', 'Browser skills']);
    const paid = screen.getByRole('article', { name: 'Accessible interfaces' });
    expect(paid).toHaveTextContent('Paid'); expect(paid).toHaveTextContent('₹1,299');
    expect(paid).toHaveTextContent('Step 2');
    expect(paid).toHaveTextContent('Aligns with your interests');
    expect(paid).toHaveTextContent('Web foundations — take this earlier in the pathway');
    expect(screen.getByRole('link', { name: 'Web foundations' })).toHaveAttribute('href', '/courses/111111111111111111111111');
    expect(paid).toHaveTextContent('Match score: 61/100');
    expect(paid).toHaveTextContent('Interest match: 30'); expect(paid).toHaveTextContent('Goal match: 8');
    expect(paid).toHaveTextContent('Skill match: 15'); expect(paid).toHaveTextContent('Level fit: 8'); expect(paid).toHaveTextContent('Prerequisite fit: 0');
    expect(paid).toHaveTextContent('Complete prerequisite course: Web foundations');
    expect(screen.getByRole('article', { name: 'Web foundations' })).toHaveTextContent('Free');
    expect(screen.getAllByRole('link', { name: 'View course' }).map(link => link.getAttribute('href'))).toEqual(['/courses/111111111111111111111111', '/courses/222222222222222222222222', '/courses/333333333333333333333333']);
    expect(screen.queryByRole('button', { name: /buy|purchase|enroll/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/SkillForge instructor|0 lessons/)).not.toBeInTheDocument();
    expect(requests.some(request => /\/courses\/[^/]+\/enroll|\/payments\/orders/.test(request.path))).toBe(false);
  });

  it('renders server progress and next lesson without computing completion or eligibility', async () => {
    server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active], recap } } : undefined);
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
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [{ ...active, assessments, certificateEligibility }], recap } } : undefined);
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
      guidance: { activeCourses: [{ ...active, certificate, certificateEligibility: { ...certificateEligibility, eligible: true } }], recap } } } : undefined);
    await mount();
    fireEvent.change(await screen.findByLabelText('Ask for guidance'), { target: { value: 'Certificate status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText(String(expected))).toBeInTheDocument();
    expect(screen.queryByText('Certificate requirements remaining')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim certificate/i })).not.toBeInTheDocument();
  });

  it('sends an explicitly selected active course and displays only the returned server reply and grounding', async () => {
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active], recap } } : path === '/ai/chat' ? { success: true, assistant: { message: 'Your next recorded lesson is Components in practice.', grounding: 'PROGRESS', guidance: { activeCourses: [active], recap } } } : undefined);
    await mount(); await screen.findByLabelText('Ask for guidance');
    fireEvent.change(screen.getByLabelText('Course for guidance'), { target: { value: active.course.id } });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'What is my next lesson?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    expect(await screen.findByText('Your next recorded lesson is Components in practice.')).toBeInTheDocument();
    expect(requests.find(r => r.path === '/ai/chat')!.body).toEqual({ message: 'What is my next lesson?', courseId: active.course.id });
    expect(screen.getByLabelText('Ask for guidance')).toHaveValue('');
  });

  it('review: renders chat-returned progress after a failed guidance read without adding course-selection options', async () => {
    const requests = server(({ path }) => path === '/ai/guidance' ? new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE' } }), { status: 503 }) : path === '/ai/chat' ? { success: true, assistant: { message: 'Here is your recorded next lesson.', grounding: 'PROGRESS', guidance: { activeCourses: [active], recap } } } : undefined);
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
    const requests = server(({ path }) => path === '/ai/guidance' ? { success: true, guidance: { activeCourses: [active], recap } } : path === '/ai/chat' ? { success: true, assistant: { message: 'Review the returned course guidance.', grounding: 'PROGRESS', guidance: { activeCourses: [otherActive], recap } } } : undefined);
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
    const destination = await screen.findByRole('heading', { name: 'Your learning pathway' });
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

  it('hands a metadata-limited question to the selected course PDF tutor without submitting it automatically', async () => {
    const materialId = '999999999999999999999999';
    const materialsPath = `/courses/${active.course.id}/materials`;
    const material = { id: materialId, title: 'React study notes', lectureId: null, pageCount: 4, downloadEndpoint: `/api/v1${materialsPath}/${materialId}/download` };
    const requests = server(({ path }) => path === '/ai/guidance'
      ? { success: true, guidance: { activeCourses: [active], recap } }
      : path === materialsPath
        ? { materials: [material] }
        : path === `/courses/${active.course.id}`
          ? { course: { id: active.course.id, title: active.course.title, lectures: [active.nextLecture] } }
          : path === '/ai/chat'
            ? { success: true, assistant: { message: 'I can use course structure and recorded progress, but cannot read lesson content or watch videos.', grounding: 'COURSE_METADATA' } }
            : path === '/ai/course-tutor'
              ? { tutor: { outcome: 'ANSWERED', answer: 'The published notes explain the concept.', citations: [{ materialId, title: material.title, pageStart: 2, pageEnd: 2 }] } }
              : undefined);
    await mount();
    fireEvent.change(await screen.findByLabelText('Course for guidance'), { target: { value: active.course.id } });
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Explain components using the course notes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    await screen.findByText(/cannot read lesson content/i);
    expect(await screen.findByRole('button', { name: 'Ask this about published PDFs' })).toBeEnabled();
    expect(requests.some(request => request.path === '/ai/course-tutor')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ask this about published PDFs' }));
    const materialsQuestion = await screen.findByLabelText('Question about course materials');
    await waitFor(() => expect(materialsQuestion).toHaveValue('Explain components using the course notes.'));
    expect(screen.getByLabelText('Course for materials')).toHaveValue(active.course.id);
    expect(requests.some(request => request.path === '/ai/course-tutor')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ask materials tutor' }));
    expect(await screen.findByText('The published notes explain the concept.')).toBeInTheDocument();
    expect(requests.find(request => request.path === '/ai/course-tutor')?.body).toEqual({ courseId: active.course.id, question: 'Explain components using the course notes.' });
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
    expect(await screen.findByRole('heading', { name: 'Web foundations' })).toBeInTheDocument();
  });

  it('preserves the question on failure and retries only on explicit submission while keeping catalog guidance', async () => {
    let failed = true;
    const requests = server(({ path }) => path === '/ai/chat' ? failed ? new Response(JSON.stringify({ error: { code: 'AI_UNAVAILABLE', message: 'raw sensitive error' } }), { status: 503 }) : { success: true, assistant: { message: 'Review the published courses and their match signals.', grounding: 'CATALOG', recommendations } } : undefined);
    await mount(); await screen.findByLabelText('Ask for guidance');
    fireEvent.change(screen.getByLabelText('Ask for guidance'), { target: { value: 'Help me choose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for guidance' }));
    const alert = await screen.findByRole('alert'); expect(alert).not.toHaveTextContent(/raw|sensitive/);
    expect(screen.getByLabelText('Ask for guidance')).toHaveValue('Help me choose');
    expect(screen.getByRole('heading', { name: 'Web foundations' })).toBeInTheDocument();
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

describe('Weekly study plan', () => {
  const lesson = {
    id: 'LESSON:444444444444444444444444:555555555555555555555555', kind: 'LESSON' as const,
    courseId: active.course.id, courseTitle: active.course.title, sourceId: active.nextLecture.id,
    title: 'Study lesson: Components in practice', day: '2026-11-03', dueDay: null, minutes: 30,
  };
  const quiz = {
    id: 'QUIZ:444444444444444444444444:666666666666666666666666', kind: 'QUIZ' as const,
    courseId: active.course.id, courseTitle: active.course.title, sourceId: '666666666666666666666666',
    title: 'Review quiz: React components', day: '2026-11-04', dueDay: null, minutes: 30,
  };
  function planFor(startDate: string, timeZone: string) {
    const day = (offset: number) => {
      const date = new Date(`${startDate}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };
    return {
      weekStart: startDate, timeZone, availableMinutes: 180, plannedMinutes: 60, message: null,
      sessions: [{ ...lesson, day: day(1) }, { ...quiz, day: day(2), dueDay: day(2) }],
    };
  }

  it('lets a student generate, edit, reorder, remove, explicitly save, and delete a private plan', async () => {
    let savedPlan: ReturnType<typeof planFor> | null = null;
    const requests = server(request => {
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const startDate = request.body?.startDate ?? query.get('startDate') ?? '2026-11-02';
      const timeZone = request.body?.timeZone ?? query.get('timeZone') ?? 'UTC';
      const suggestions = planFor(startDate, timeZone);
      if (request.path === '/ai/study-plan/preview') return { success: true, preview: suggestions };
      if (request.path.startsWith('/ai/study-plan?') && request.init.method === 'DELETE') {
        savedPlan = null;
        return { success: true, deleted: true };
      }
      if (request.path.startsWith('/ai/study-plan?')) {
        return { success: true, plan: savedPlan, preview: savedPlan ? null : { ...suggestions, sessions: [], plannedMinutes: 0 } };
      }
      if (request.path === '/ai/study-plan' && request.init.method === 'PUT') {
        savedPlan = {
          ...suggestions,
          sessions: request.body.sessions.map((edit: Pick<StudyPlanSession, 'id' | 'day' | 'minutes'>) => {
            const source = suggestions.sessions.find(session => session.id === edit.id);
            if (!source) throw new Error('Unexpected study-plan session');
            return { ...source, day: edit.day, minutes: edit.minutes };
          }),
          plannedMinutes: request.body.sessions.reduce((sum: number, session: { minutes: number }) => sum + session.minutes, 0),
        };
        return { success: true, plan: savedPlan };
      }
      return undefined;
    });

    await mount();
    const generateButton = await screen.findByRole('button', { name: 'Generate a fresh study plan' });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);
    const lessonDay = await screen.findByLabelText<HTMLInputElement>(`Study day for ${lesson.title}`);
    const quizDay = await screen.findByLabelText<HTMLInputElement>(`Study day for ${quiz.title}`);
    expect(await screen.findByText('Due soon')).toBeInTheDocument();
    const changedDayDate = new Date(`${lessonDay.getAttribute('value') ?? lessonDay.value}T00:00:00.000Z`);
    changedDayDate.setUTCDate(changedDayDate.getUTCDate() + 1);
    const changedDay = changedDayDate.toISOString().slice(0, 10);
    fireEvent.change(lessonDay, { target: { value: changedDay } });
    fireEvent.change(screen.getByLabelText(`Minutes for ${lesson.title}`), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: `Move ${lesson.title} later` }));
    const planPanel = screen.getByRole('region', { name: 'Weekly study plan' });
    expect(within(planPanel).getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual([quiz.title, lesson.title]);
    fireEvent.click(screen.getByRole('button', { name: `Remove ${quiz.title}` }));
    expect(screen.queryByLabelText(`Study day for ${quiz.title}`)).not.toBeInTheDocument();
    expect(quizDay).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save this plan' }));
    await screen.findByText('Your study plan is saved.');
    const saveRequest = requests.find(request => request.path === '/ai/study-plan' && request.init.method === 'PUT');
    expect(saveRequest?.body.sessions).toEqual([{ id: lesson.id, day: changedDay, minutes: 45 }]);
    expect(requests.every(request => request.init.credentials === 'include')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete saved plan' }));
    expect(await screen.findByText('Your saved plan was deleted.')).toBeInTheDocument();
    expect(requests.some(request => request.path.startsWith('/ai/study-plan?') && request.init.method === 'DELETE')).toBe(true);
  });

  it('blocks saving edits that exceed the stated weekly availability', async () => {
    const suggestionsFor = (request: Request) => {
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      const startDate = request.body?.startDate ?? query.get('startDate') ?? '2026-11-02';
      const timeZone = request.body?.timeZone ?? query.get('timeZone') ?? 'UTC';
      return { ...planFor(startDate, timeZone), availableMinutes: 60 };
    };
    server(request => request.path.startsWith('/ai/study-plan?') ? { success: true, plan: null, preview: suggestionsFor(request) }
      : request.path === '/ai/study-plan/preview' ? { success: true, preview: suggestionsFor(request) } : undefined);
    await mount();
    const minutes = await screen.findByLabelText<HTMLInputElement>(`Minutes for ${lesson.title}`);
    fireEvent.change(minutes, { target: { value: '90' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/fits your weekly availability/i);
    expect(screen.getByRole('button', { name: 'Save this plan' })).toBeDisabled();
  });

  it('explains the missing weekly availability instead of showing an invented plan', async () => {
    server(request => {
      if (!request.path.startsWith('/ai/study-plan?')) return undefined;
      const query = new URLSearchParams(request.path.split('?')[1] ?? '');
      return { success: true, plan: null, preview: {
        weekStart: query.get('startDate'), timeZone: query.get('timeZone'), availableMinutes: null,
        plannedMinutes: 0, message: 'Add your weekly study availability to your learning profile to build a plan.', sessions: [],
      } };
    });
    await mount();
    expect(await screen.findByText(/Add your weekly study availability/)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('safe AI error presentation', () => {
  it.each([
    [503, 'AI_UNAVAILABLE', /learning assistant.*temporarily unavailable/i, true],
    [503, 'AI_STUDY_PLAN_UNAVAILABLE', /study plan.*temporarily unavailable/i, true],
    [400, 'AI_PROFILE_INVALID', /learning profile/i, false],
    [400, 'AI_CHAT_INVALID', /2000/i, false],
    [400, 'AI_STUDY_PLAN_INVALID', /study plan.*dates/i, true],
    [403, 'AI_ENROLLMENT_REQUIRED', /active.*course/i, false],
  ] as const)('maps %s %s without server diagnostics', (status, code, expected, retryable) => {
    const shown = presentApiError(new ApiError(status, 'provider-secret diagnostic', undefined, { code }), { returnTo: '/dashboard' });
    expect(shown.message).toMatch(expected); expect(shown.message).not.toContain('provider-secret'); expect(shown.retryable).toBe(retryable);
  });
});
