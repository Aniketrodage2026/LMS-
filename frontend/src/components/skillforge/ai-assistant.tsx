import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Compass, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/api/auth';
import { useAiChat, useAiGuidance, useAiProfile, useAiRecommendations, useSaveAiProfile } from '@/lib/api/hooks';
import { inr, type AiGrounding, type AiProfileField, type AiProfileInput, type AiProfileResponse, type AiRecommendation, type AiGuidance } from '@/lib/api/models';
import { presentApiError } from '@/lib/errors/present';
import { ErrorGuidance, Loading, Status } from './shared';

const groundingLabels: Record<AiGrounding, string> = { PROFILE: 'Profile', CATALOG: 'Catalog', PROGRESS: 'Progress', COURSE_METADATA: 'Course structure' };
const fieldLabels: Record<AiProfileField, string> = { careerGoal: 'Career goal', interests: 'Interests', experienceLevel: 'Experience level', weeklyAvailabilityHours: 'Weekly availability (hours)' };
const signalLabels = { interestCategoryMatch: 'Interest match', goalKeywordMatch: 'Goal match', skillMatch: 'Skill match', levelFit: 'Level fit', prerequisiteFit: 'Prerequisite fit' } as const;
const assignmentStatusLabels = { NOT_SUBMITTED: 'Not submitted', SUBMITTED: 'Awaiting review', PENDING_REVIEW: 'Awaiting review', GRADED: 'Graded', RESUBMISSION_REQUESTED: 'Resubmission requested' } as const;
const errorContext = { returnTo: '/dashboard', workspaceRole: 'STUDENT' as const };

function ProfileCapture({ data }: { data: AiProfileResponse }) {
  const save = useSaveAiProfile();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AiProfileInput>({});
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const id = useId();
  const field = data.missingFields[step];
  useEffect(() => { if (step > 0) inputRef.current?.focus(); }, [step]);
  if (!field) return null;
  const last = step === data.missingFields.length - 1;
  const valid = field === 'weeklyAvailabilityHours' ? Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 80
    : field === 'interests' ? value.split(',').some(item => item.trim()) && value.split(',').length <= 20 && value.split(',').every(item => item.trim().length > 0 && item.trim().length <= 80)
      : Boolean(value.trim());
  const advance = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!valid || save.isPending) return;
    const next = { ...draft, [field]: field === 'weeklyAvailabilityHours' ? Number(value) : field === 'interests' ? value.split(',').map(item => item.trim()) : value.trim() };
    setDraft(next);
    if (last) {
      try { await save.mutateAsync(next); } catch { /* The safe error below retains the draft. */ }
    } else { setStep(step + 1); setValue(''); }
  };
  return <div className="max-w-xl">
    <p className="text-sm text-muted-foreground">A few details will help you find your next direction. Your profile is saved after the last answer.</p>
    <form onSubmit={advance} className="grid gap-3">
      <label htmlFor={id} className="font-medium text-sm">{fieldLabels[field]}</label>
      {field === 'experienceLevel' ? <select id={id} ref={element => { inputRef.current = element; }} value={value} onChange={event => setValue(event.target.value)} required disabled={save.isPending} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring">
        <option value="">Choose your experience level</option><option value="BEGINNER">Beginner</option><option value="INTERMEDIATE">Intermediate</option><option value="ADVANCED">Advanced</option>
      </select> : <Input id={id} ref={element => { inputRef.current = element; }} type={field === 'weeklyAvailabilityHours' ? 'number' : 'text'} min={field === 'weeklyAvailabilityHours' ? 1 : undefined} max={field === 'weeklyAvailabilityHours' ? 80 : undefined} step={field === 'weeklyAvailabilityHours' ? 1 : undefined} maxLength={field === 'careerGoal' ? 500 : undefined} required value={value} onChange={event => setValue(event.target.value)} disabled={save.isPending} aria-describedby={field === 'interests' ? `${id}-hint` : undefined} />}
      {field === 'interests' && <p id={`${id}-hint`} className="text-xs text-muted-foreground">Separate topics with commas. Up to 20 topics, 80 characters each.</p>}
      <Button className="justify-self-start" disabled={!valid || save.isPending} type="submit">{save.isPending ? 'Saving…' : last ? 'Save learning profile' : 'Next'}<ArrowRight aria-hidden="true" /></Button>
    </form>
    {save.error && <div className="mt-3"><ErrorGuidance error={presentApiError(save.error, errorContext)} onRetry={() => { void advance(); }} /></div>}
  </div>;
}

function Recommendations({ items }: { items: AiRecommendation[] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No matching available courses right now. Check the catalog again later.</p>;
  return <div className="course-grid">{items.map(({ course, score, signals, unmetPrerequisites }) => <article key={course.id} aria-label={course.title} className="course-card min-w-0 flex flex-col">
    {course.thumbnailUrl && <img src={course.thumbnailUrl} alt="" loading="lazy" className="w-full aspect-video object-cover" width={640} height={360} />}
    <div className="course-body flex flex-col flex-1 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><Status tone={course.accessType === 'FREE' ? 'success' : 'primary'}>{course.accessType === 'FREE' ? 'Free' : 'Paid'}</Status><strong>{course.accessType === 'FREE' ? '₹0' : inr(course.price)}</strong></div>
      <div className="course-category"><span>{course.category}</span>{course.level && <span>{course.level.toLowerCase()}</span>}</div>
      <h3 className="text-base mb-0 break-words">{course.title}</h3>
      <p className="text-sm text-muted-foreground mb-0 break-words">{course.description}</p>
      <details className="text-xs"><summary className="cursor-pointer font-medium focus-visible:outline">Match score: {score}/100</summary>
        <ul className="mt-2 grid gap-1 list-none pl-0">{Object.entries(signalLabels).filter(([key]) => (key !== 'skillMatch' || course.skills.length > 0) && (key !== 'levelFit' || course.level !== null)).map(([key, label]) => <li key={key}>{label}: {signals[key as keyof typeof signals]}</li>)}</ul>
      </details>
      {unmetPrerequisites.length > 0 && <div className="text-xs text-muted-foreground"><p className="font-medium mb-1">Before you start</p><ul className="list-disc pl-4">{unmetPrerequisites.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
      <Button variant="outline" asChild className="mt-auto w-full"><Link to="/courses/$courseId" params={{ courseId: course.id }}>View course<ArrowRight aria-hidden="true" /></Link></Button>
    </div>
  </article>)}</div>;
}

function ProgressGuidance({ guidance }: { guidance: AiGuidance }) {
  return <div className="grid gap-3">{guidance.activeCourses.map(({ course, progress, nextLecture, assessments, certificate, certificateEligibility }) => <div key={course.id} className="rounded-lg border p-4 flex flex-wrap items-center justify-between gap-4">
    <div className="min-w-0"><h3 className="text-base mb-1 break-words">{course.title}</h3><p className="text-xs text-muted-foreground mb-2">{progress.completionPercent}% complete · {progress.completedLectures} of {progress.totalLectures} lessons</p>
      {nextLecture ? <><p className="text-xs text-muted-foreground mb-1">Next lesson</p><p className="text-sm mb-0 break-words">{nextLecture.title}</p></> : <p className="text-sm mb-0">No next lesson recorded.</p>}</div>
    <Button variant="outline" asChild>{nextLecture ? <Link to="/learn/$courseId" params={{ courseId: course.id }} search={{ lecture: nextLecture.id }}>Open next lesson<ArrowRight aria-hidden="true" /></Link> : <Link to="/courses/$courseId" params={{ courseId: course.id }}>View course<ArrowRight aria-hidden="true" /></Link>}</Button>
    {(assessments.totalQuizzes > 0 || assessments.totalAssignments > 0) && <div className="w-full border-t pt-3 text-sm">
      <p className="font-medium mb-2">Assessments · {assessments.totalQuizzes} quizzes · {assessments.totalAssignments} assignments</p>
      <ul className="list-none pl-0 grid gap-2">
        {assessments.quizzes.map(quiz => <li key={quiz.id} className="break-words"><Link className="underline underline-offset-2" to="/quizzes/$courseId/$quizId" params={{ courseId: course.id, quizId: quiz.id }}>{quiz.title}</Link><p className="text-xs text-muted-foreground mb-0">{quiz.passed ? 'Passed' : quiz.bestPercentage === null ? 'Not attempted' : 'Not passed'}{quiz.bestPercentage !== null && ` · Best: ${quiz.bestPercentage}%`} · Pass mark: {quiz.passMark}%</p></li>)}
        {assessments.assignments.map(assignment => <li key={assignment.id} className="break-words"><Link className="underline underline-offset-2" to="/assignments/$courseId/$assignmentId" params={{ courseId: course.id, assignmentId: assignment.id }}>{assignment.title}</Link><p className="text-xs text-muted-foreground mb-0">{assignmentStatusLabels[assignment.status]}{assignment.status === 'GRADED' && assignment.marks !== null && ` · ${assignment.marks} / ${assignment.maxMarks}`}</p></li>)}
      </ul>
      {(assessments.totalQuizzes > assessments.quizzes.length || assessments.totalAssignments > assessments.assignments.length) && <p className="text-xs text-muted-foreground mt-2 mb-0">Showing a selection of published assessments. The certificate checklist includes all requirements.</p>}
    </div>}
    {(certificate || certificateEligibility) && <div className="w-full border-t pt-3 text-sm">
      <p className="font-medium mb-2">{certificate ? 'Certificate issued' : certificateEligibility?.eligible ? 'Certificate ready to claim' : 'Certificate requirements remaining'}</p>
      {!certificate && certificateEligibility && !certificateEligibility.eligible && <ul className="list-none pl-0 grid gap-1 text-xs text-muted-foreground">
        <li>Lesson completion: {certificateEligibility.lecturePercent}% · {certificateEligibility.lectureRequirementMet ? 'Requirement met' : 'Complete more lessons'}</li>
        <li>Quizzes passed: {certificateEligibility.passedQuizzes} of {certificateEligibility.requiredQuizzes} · {certificateEligibility.quizzesRequirementMet ? 'Requirement met' : 'Pass the remaining quizzes'}</li>
        <li>Assignments graded: {certificateEligibility.gradedAssignments} of {certificateEligibility.requiredAssignments} · {certificateEligibility.assignmentsRequirementMet ? 'Requirement met' : 'Review assignment status'}</li>
        <li>Assessment average: {certificateEligibility.assessmentAverage}% · {certificateEligibility.assessmentRequirementMet ? 'Requirement met' : 'Improve assessment results'}</li>
      </ul>}
      <Link className="underline underline-offset-2" to="/student/$section" params={{ section: 'certificates' }}>Review certificates</Link>
    </div>}
  </div>)}</div>;
}

function CompassContent() {
  const profile = useAiProfile(); const guidance = useAiGuidance();
  const recommendations = useAiRecommendations(profile.data?.missingFields.length === 0);
  const chat = useAiChat();
  const [question, setQuestion] = useState(''); const [courseId, setCourseId] = useState('');
  const [profileCompleted, setProfileCompleted] = useState(false);
  const sawIncompleteProfile = useRef(false);
  const coursesHeadingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    if (!profile.data || profile.error) return;
    if (profile.data.missingFields.length > 0) { sawIncompleteProfile.current = true; return; }
    if (sawIncompleteProfile.current) {
      sawIncompleteProfile.current = false;
      setProfileCompleted(true);
      coursesHeadingRef.current?.focus();
    }
  }, [profile.data, profile.error]);
  // The read endpoint alone supplies selectable active courses. A chat reply cannot add options.
  const activeCourses = guidance.data?.activeCourses ?? [];
  const displayedGuidance = chat.data?.guidance ?? (guidance.error ? undefined : guidance.data);
  const selectedCourseId = activeCourses.some(item => item.course.id === courseId) ? courseId : '';
  const ask = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!question.trim() || question.length > 2000 || chat.isPending) return;
    try { await chat.mutateAsync({ message: question, ...(selectedCourseId ? { courseId: selectedCourseId } : {}) }); setQuestion(''); }
    catch { /* Keep the question for an explicit retry. */ }
  };
  const grounding = chat.data?.grounding ?? (activeCourses.length ? 'PROGRESS' : profile.data?.missingFields.length ? 'PROFILE' : 'CATALOG');
  return <section aria-labelledby={`${id}-title`} className="mb-8">
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="pb-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id={`${id}-title`} className="text-xl mb-0 flex items-center gap-2"><Compass size={22} className="text-primary" aria-hidden="true" />Learning compass</h2><Status tone="primary">{groundingLabels[grounding]}</Status></div></CardHeader>
      <div className="mx-6 mb-5 border-l-4 border-primary bg-secondary px-4 py-3"><p className="text-xs font-semibold mb-1">Next direction</p><p className="text-sm mb-0">{profile.isPending ? 'Finding your learning direction…' : profile.data?.missingFields.length ? 'Build your learning profile, one answer at a time.' : displayedGuidance?.activeCourses.length ? 'Use your recorded progress to choose your next step.' : 'Explore courses matched to your learning profile.'}</p></div>
      <CardContent className="grid gap-5">
        <div role="status" aria-live="polite" aria-atomic="true" className={profileCompleted ? 'text-sm text-success' : 'sr-only'}>{profileCompleted && 'Your learning profile is ready. Explore your next direction below.'}</div>
        {profile.isPending ? <Loading rows={1} label="Loading learning compass" /> : profile.error ? <ErrorGuidance error={presentApiError(profile.error, errorContext)} onRetry={() => { void profile.refetch(); }} /> : profile.data && profile.data.missingFields.length > 0 ? <ProfileCapture key={profile.data.missingFields.join(',')} data={profile.data} /> : null}
        {guidance.isPending && !chat.data?.guidance && <Loading rows={1} label="Loading recorded progress" />}
        {guidance.error && <ErrorGuidance error={presentApiError(guidance.error, errorContext)} onRetry={() => { void guidance.refetch(); }} />}
        {displayedGuidance && displayedGuidance.activeCourses.length > 0 && <ProgressGuidance guidance={displayedGuidance} />}
        {(profile.data?.missingFields.length === 0 || chat.data?.recommendations !== undefined) && <div className="grid gap-3"><div className="flex items-center gap-2"><h3 ref={coursesHeadingRef} tabIndex={-1} className="text-base mb-0 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Courses to explore</h3><Status>Catalog</Status></div>
          {chat.data?.recommendations ? <Recommendations items={chat.data.recommendations} /> : recommendations.isPending ? <Loading rows={1} label="Loading course matches" /> : recommendations.error ? <ErrorGuidance error={presentApiError(recommendations.error, errorContext)} onRetry={() => { void recommendations.refetch(); }} /> : recommendations.data ? <Recommendations items={recommendations.data} /> : null}
        </div>}
        <p id={`${id}-limit`} className="text-xs text-muted-foreground mb-0">Metadata only: guidance uses your profile, catalog, course structure, and recorded progress. The assistant cannot read lesson content or watch videos.</p>
        {profile.data && <div className="border-t pt-5 grid gap-4">
          <form onSubmit={ask} className="grid gap-3" aria-describedby={`${id}-limit`}>
            {activeCourses.length > 0 && <div className="grid gap-2 max-w-xl"><label htmlFor={`${id}-course`} className="text-sm font-medium">Course for guidance</label><select id={`${id}-course`} value={selectedCourseId} onChange={event => setCourseId(event.target.value)} disabled={chat.isPending} className="rounded-md border bg-background px-3 py-2 text-sm w-full focus-visible:ring-2 focus-visible:ring-ring"><option value="">General learning guidance</option>{activeCourses.map(item => <option key={item.course.id} value={item.course.id}>{item.course.title}</option>)}</select></div>}
            <label htmlFor={`${id}-question`} className="text-sm font-medium">Ask for guidance</label>
            <textarea id={`${id}-question`} value={question} onChange={event => setQuestion(event.target.value)} maxLength={2000} rows={3} required disabled={chat.isPending} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring" />
            <Button type="submit" className="justify-self-start" disabled={chat.isPending || !question.trim() || question.length > 2000}>{chat.isPending ? 'Asking…' : 'Ask for guidance'}<ArrowRight aria-hidden="true" /></Button>
          </form>
          {chat.error && <ErrorGuidance error={presentApiError(chat.error, errorContext)} onRetry={() => { void ask(); }} />}
          <div aria-live="polite" aria-atomic="true">{chat.data && <div className="rounded-lg bg-muted p-4"><Status tone="primary">{groundingLabels[chat.data.grounding]}</Status><p className="text-sm whitespace-pre-wrap break-words mt-3 mb-0">{chat.data.message}</p></div>}</div>
        </div>}
      </CardContent>
    </Card>
  </section>;
}

export function LearningCompass() {
  const { user } = useAuth();
  return user?.role === 'STUDENT' ? <CompassContent key={user.id} /> : null;
}
