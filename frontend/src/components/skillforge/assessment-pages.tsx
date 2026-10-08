import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Award, CheckCircle2, ChevronLeft, ChevronRight, CircleDot, ClipboardList, Download, FileText, Layers, ListVideo, LockKeyhole, Play, RotateCcw, Upload, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, API_ROOT, pick, pickList, errorText, errorStatus } from '@/lib/api/client';
import { useCourse } from '@/lib/api/hooks';
import { fmtDate, monotonic, progressPayload, toLecture, toLearningProgress, toSubmission, submissionState, canSubmit, validSubmissionFile, ALLOWED_SUBMISSION_TYPES, MAX_UPLOAD_MB } from '@/lib/api/models';
import { RequireRole, Brand, ProgressBar, Status, Empty, ErrorBox, Loading, Notice, PageHeading, Workspace } from './shared';

export function PlayerPage({ id, lecture }: { id: string; lecture?: string | undefined }) { return <RequireRole roles={['STUDENT']}><Player key={`${id}:${lecture ?? ''}`} id={id} initial={lecture} /></RequireRole>; }
function Player({ id, initial }: { id: string; initial?: string | undefined }) {
  const qc = useQueryClient(); const course = useCourse(id);
  const progress = useQuery({ queryKey: ['progress', id], queryFn: async () => toLearningProgress(pick<any>(await api(`/courses/${id}/progress`), 'progress')) });
  const [sidebar, setSidebar] = useState(true);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [percent, setPercent] = useState(0);
  const [currentId, setCurrentId] = useState<string | undefined>(initial);
  const lectures = progress.data?.lectures ?? [];
  useEffect(() => {
    const p = progress.data; if (!p) return;
    setCompleted(new Set(lectures.filter(lecture => lecture.completed).map(lecture => lecture.id)));
    setPercent(prev => monotonic(prev, p.completionPercent));
    setCurrentId(current => current ?? lectures.find(lecture => lecture.watchedSeconds > 0)?.id ?? lectures[0]?.id);
  }, [progress.data]);
  const current = currentId ?? lectures[0]?.id;
  const idx = lectures.findIndex(l => l.id === current);
  const preview = useQuery({ queryKey: ['preview', id], retry: false, queryFn: async () => toLecture(pick(await api(`/courses/${id}/preview`), 'lecture', 'preview')) });
  const isPreview = preview.data?.id === current;
  const lec = useQuery({ queryKey: ['lecture', id, current, isPreview], enabled: Boolean(current) && !preview.isLoading, retry: false, queryFn: async () => isPreview ? preview.data! : toLecture(pick(await api(`/courses/${id}/lectures/${current}`), 'lecture')) });
  const startAt = Number(lectures.find(lecture => lecture.id === current)?.watchedSeconds ?? 0) || 0;
  const progressDuration = Number(lectures.find(lecture => lecture.id === current)?.durationSeconds ?? 0);
  const authoritativeDuration = progressDuration > 0 ? progressDuration : Number(lec.data?.duration ?? 0) || 0;

  // Progress saving: periodically, on pause, on completion, before leaving. Never move backwards.
  const video = useRef<HTMLVideoElement>(null); const maxPos = useRef(0); const lastSent = useRef(0); const [watched, setWatched] = useState(0);
  useEffect(() => { maxPos.current = startAt; lastSent.current = startAt; setWatched(0); }, [current, startAt]);
  const save = useCallback((keepalive = false, force = false) => {
    const v = video.current; if (!v || !current) return;
    const hasDuration = authoritativeDuration > 0 || Number.isFinite(v.duration) && v.duration > 0;
    if (!hasDuration) return;
    const pos = monotonic(maxPos.current, v.currentTime); maxPos.current = pos;
    if (pos <= lastSent.current + 1 && !keepalive && !force) return; lastSent.current = pos;
    const body = progressPayload(pos, authoritativeDuration, v.duration);
    if (keepalive) { void fetch(`${API_ROOT}/courses/${id}/lectures/${current}/progress`, { method: 'PATCH', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined); return; }
    api(`/courses/${id}/lectures/${current}/progress`, { method: 'PATCH', body }).then(j => { const p = pick<any>(j, 'progress'); if (p?.completed) setCompleted(s => new Set(s).add(current)); }).catch(() => undefined);
  }, [id, current, authoritativeDuration]);
  useEffect(() => { const t = setInterval(() => { if (video.current && !video.current.paused) save(); }, 15000); const leave = () => save(true); const vis = () => document.visibilityState === 'hidden' && save(true); window.addEventListener('beforeunload', leave); document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); window.removeEventListener('beforeunload', leave); document.removeEventListener('visibilitychange', vis); }; }, [save]);

  const [completing, setCompleting] = useState(false); const [actionErr, setActionErr] = useState('');
  const complete = async () => { if (!current) return; setCompleting(true); setActionErr(''); try { save(); await api(`/courses/${id}/lectures/${current}/complete`, { method: 'POST' }); setCompleted(s => new Set(s).add(current)); void qc.invalidateQueries({ queryKey: ['me', 'learning'] }); void qc.invalidateQueries({ queryKey: ['eligibility', id] }); } catch (e) { setActionErr(errorText(e)); } finally { setCompleting(false); } };
  const selectLecture = (next: string | undefined) => { if (!next || next === current) return; save(false, true); setCurrentId(next); };
  if (course.isLoading || progress.isLoading) return <main className="wide public-page"><Loading rows={3} /></main>;
  if (course.error) return <main className="wide public-page"><ErrorBox message={errorText(course.error)} /></main>;
  if (progress.error && errorStatus(progress.error) === 403) return <main className="wide public-page"><Empty title="This course isn’t in your library yet" description="Enroll or purchase the course to start learning." action={<Button asChild><Link to="/courses/$courseId" params={{ courseId: id }}>View course</Link></Button>} /></main>;
  const pct = Math.max(percent, lectures.length ? Math.round(completed.size / lectures.length * 100) : 0);
  const isDone = current ? completed.has(current) : false;
  return <div className="player-page"><header className="player-top"><div className="flex items-center gap-4"><Brand /><Link to="/dashboard" className="hidden md:inline-flex items-center gap-1 text-xs"><ArrowLeft size={14} />Dashboard</Link></div><div className="player-progress"><span>{course.data?.title}</span><ProgressBar value={pct} /><strong>{Math.round(pct)}%</strong></div><Button variant="ghost" size="icon" aria-label="Toggle curriculum" onClick={() => setSidebar(!sidebar)}><ListVideo /></Button></header>
    <div className={`player-layout ${sidebar ? '' : 'sidebar-collapsed'}`}><main className="player-main">
      {lec.isLoading ? <div className="player-video bg-muted animate-pulse" /> : lec.error ? <div className="player-video grid place-items-center"><ErrorBox message={errorStatus(lec.error) === 403 ? 'This lesson is locked. Enroll in the course to unlock it.' : errorText(lec.error)} /></div> : lec.data?.videoUrl ? <video key={current} ref={video} className="player-video" controls src={lec.data.videoUrl} aria-label={lec.data.title} onLoadedMetadata={e => { if (startAt && startAt < e.currentTarget.duration - 5) e.currentTarget.currentTime = startAt; }} onTimeUpdate={e => { const v = e.currentTarget; maxPos.current = monotonic(maxPos.current, v.currentTime); setWatched(v.duration ? v.currentTime / v.duration : 0); }} onPause={() => save()} onEnded={() => { save(); if (!isDone) void complete(); }} /> : <div className="player-video grid place-items-center"><Empty title="No video yet" description="This lesson doesn’t have a video uploaded." /></div>}
      <div className="lesson-panel"><div className="flex justify-between gap-4 flex-wrap"><div><Status tone={isDone ? 'success' : 'primary'}>{isDone ? 'Completed' : `Lesson ${idx + 1} of ${lectures.length}`}</Status><h1 className="text-2xl mt-3 mb-2">{lec.data?.title ?? lectures[idx]?.title}</h1><p className="text-sm text-muted-foreground">{lec.data?.description}</p>{!isDone && watched > 0 && <p className="text-xs text-muted-foreground">Lessons complete automatically when you finish watching. Progress is saved as you go.</p>}</div>
        <div className="flex gap-2 flex-wrap items-start"><Button onClick={complete} disabled={isDone || completing || !current}>{isDone ? <><CheckCircle2 />Completed</> : completing ? 'Saving…' : <><CheckCircle2 />Mark as Complete</>}</Button><Button variant="outline" asChild><Link to="/student/$section" params={{ section: 'assessments' }}><ClipboardList />Take Quiz</Link></Button><Button variant="outline" asChild><Link to="/student/$section" params={{ section: 'assessments' }}><Layers />View Assignment</Link></Button></div></div>
        {actionErr && <ErrorBox message={actionErr} />}
        <div className="flex justify-between mt-6"><Button variant="outline" disabled={idx <= 0} onClick={() => selectLecture(lectures[idx - 1]?.id)}><ChevronLeft />Previous lesson</Button><Button disabled={idx < 0 || idx >= lectures.length - 1} onClick={() => selectLecture(lectures[idx + 1]?.id)}>Next lesson<ChevronRight /></Button></div></div></main>
      {sidebar && <aside className="player-sidebar" aria-label="Course curriculum"><h2 className="text-base">Course content</h2><p className="text-xs text-muted-foreground">{completed.size} of {lectures.length} lessons complete</p>{lectures.map((l, i) => { const done = completed.has(l.id); const cur = l.id === current; return <button type="button" key={l.id} className={`player-lesson ${cur ? 'active' : ''}`} onClick={() => selectLecture(l.id)} aria-current={cur ? 'true' : undefined}>{done ? <CheckCircle2 size={16} className="text-success" /> : cur ? <CircleDot size={16} className="text-primary" /> : <Play size={16} />}<span>{i + 1}. {l.title}</span></button>; })}{!lectures.length && <p className="text-sm text-muted-foreground"><LockKeyhole size={14} className="inline" /> No lessons available yet.</p>}</aside>}</div></div>;
}

// ---------- Quiz ----------
export function QuizPage({ courseId, quizId }: { courseId: string; quizId: string }) { return <Workspace role="STUDENT"><Quiz courseId={courseId} quizId={quizId} /></Workspace>; }
function Quiz({ courseId, quizId }: { courseId: string; quizId: string }) {
  const qc = useQueryClient();
  const quiz = useQuery({ queryKey: ['quiz', courseId, quizId], retry: false, queryFn: async () => pick<any>(await api(`/courses/${courseId}/quizzes/${quizId}`), 'quiz') });
  const attempts = useQuery({ queryKey: ['attempts', courseId, quizId], queryFn: async () => pickList(await api(`/courses/${courseId}/quizzes/${quizId}/attempts`), 'attempts') });
  const [phase, setPhase] = useState<'intro' | 'taking' | 'result'>('intro'); const [answers, setAnswers] = useState<(number | null)[]>([]); const [i, setI] = useState(0); const [result, setResult] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (quiz.isLoading) return <Loading />;
  if (quiz.error) return <ErrorBox message={errorStatus(quiz.error) === 403 ? 'This quiz is available to enrolled students only.' : errorText(quiz.error)} onRetry={() => quiz.refetch()} />;
  const qs: any[] = quiz.data?.questions ?? []; const pass = quiz.data?.passMark ?? quiz.data?.passingScore ?? 80;
  const pctOf = (a: any) => Number(a?.percentage ?? a?.scorePercentage ?? 0);
  const best = Math.max(0, ...(attempts.data ?? []).map(pctOf));
  const start = () => { setAnswers(qs.map(() => null)); setI(0); setResult(null); setErr(''); setPhase('taking'); };
  const submit = async () => { setBusy(true); setErr(''); try { const j = await api(`/courses/${courseId}/quizzes/${quizId}/attempts`, { body: { answers } }); setResult(pick(j, 'attempt', 'result') ?? j); setPhase('result'); void qc.invalidateQueries({ queryKey: ['attempts', courseId, quizId] }); void qc.invalidateQueries({ queryKey: ['eligibility', courseId] }); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); } };
  const history = <section className="mt-10"><h2 className="text-lg">Attempt history</h2>{attempts.isLoading ? <Loading rows={1} /> : !(attempts.data?.length) ? <p className="text-sm text-muted-foreground">No attempts yet.</p> : <div className="table-wrap"><table><thead><tr><th>Attempt</th><th>Date</th><th>Score</th><th>Result</th></tr></thead><tbody>{attempts.data.map((a: any, n: number) => <tr key={a._id ?? n}><td>#{attempts.data.length - n}</td><td>{fmtDate(a.createdAt ?? a.submittedAt)}</td><td>{Math.round(pctOf(a))}%{pctOf(a) === best && best > 0 && <Status tone="primary"> Best</Status>}</td><td><Status tone={a.passed ? 'success' : 'danger'}>{a.passed ? 'Passed' : 'Failed'}</Status></td></tr>)}</tbody></table></div>}</section>;
  if (phase === 'intro') return <><PageHeading eyebrow="QUIZ" title={quiz.data?.title ?? 'Quiz'} description={quiz.data?.description} /><div className="form-shell"><ul className="text-sm grid gap-2 mb-6"><li>• {qs.length} multiple-choice questions</li><li>• Pass mark: {pass}%</li><li>• Unlimited attempts — your best score counts</li><li>• You’ll see correct answers and explanations right after you submit</li></ul>{best > 0 && <p className="text-sm mb-4">Best score so far: <strong>{Math.round(best)}%</strong></p>}<Button onClick={start} disabled={!qs.length}>Start quiz <ArrowRight /></Button></div>{history}</>;
  if (phase === 'taking') { const q = qs[i]; return <><PageHeading title={quiz.data?.title} description={`Question ${i + 1} of ${qs.length}`} /><ProgressBar value={(answers.filter(a => a !== null).length / qs.length) * 100} /><div className="quiz-layout mt-6"><div className="form-shell"><h2 className="text-lg mb-5">{q?.prompt ?? q?.question ?? q?.text}</h2><fieldset className="grid gap-3"><legend className="sr-only">Options</legend>{(q?.options ?? []).map((o: any, k: number) => <label key={k} className={`quiz-option ${answers[i] === k ? 'selected' : ''}`}><input type="radio" name={`q${i}`} checked={answers[i] === k} onChange={() => setAnswers(a => a.map((x, n) => (n === i ? k : x)))} />{typeof o === 'string' ? o : o?.text}</label>)}</fieldset>{err && <ErrorBox message={err} />}<div className="flex justify-between mt-6"><Button variant="outline" disabled={i === 0} onClick={() => setI(i - 1)}><ChevronLeft />Previous</Button>{i < qs.length - 1 ? <Button onClick={() => setI(i + 1)}>Next<ChevronRight /></Button> : <Button onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit quiz'}</Button>}</div></div><nav aria-label="Question navigator" className="flex flex-wrap gap-2 content-start">{qs.map((_, n) => <Button key={n} size="icon" variant={n === i ? 'default' : answers[n] !== null ? 'secondary' : 'outline'} onClick={() => setI(n)} aria-label={`Question ${n + 1}${answers[n] !== null ? ', answered' : ''}`}>{n + 1}</Button>)}</nav></div></>; }
  const rows: any[] = result?.results ?? result?.answers ?? result?.review ?? [];
  const pct = pctOf(result); const passed = result?.passed ?? pct >= pass;
  return <><div className="verification !py-8">{passed ? <Award size={52} className="text-success" /> : <XCircle size={52} className="text-destructive" />}<Status tone={passed ? 'success' : 'danger'}>{passed ? 'Passed' : 'Not passed yet'}</Status><h1 className="mt-4">{Math.round(pct)}%</h1><p className="text-sm text-muted-foreground">Score {result?.score ?? '—'}{result?.totalQuestions || result?.total ? ` / ${result.totalQuestions ?? result.total}` : ''} · Pass mark {pass}% · Best {Math.round(Math.max(best, pct))}%</p><Button onClick={start}><RotateCcw />Retry quiz</Button></div>
    <div className="grid gap-4">{qs.map((q, n) => { const r = rows.find((x: any) => Number(x?.questionIndex ?? -1) === n) ?? rows[n] ?? {}; const sel = r.selectedOptionIndex ?? r.selected ?? answers[n]; const cor = r.correctOptionIndex ?? r.correctAnswer ?? r.correct; const ok = r.isCorrect ?? (sel != null && sel === cor); const opt = (k: any) => (k == null ? 'Not answered' : typeof q.options?.[k] === 'string' ? q.options[k] : q.options?.[k]?.text ?? `Option ${Number(k) + 1}`); return <article key={n} className="summary-block"><div className="flex gap-2 items-start">{ok ? <CheckCircle2 className="text-success shrink-0" /> : <XCircle className="text-destructive shrink-0" />}<h3 className="m-0">{n + 1}. {q.prompt ?? q.question ?? q.text}</h3></div><p className="text-sm mt-3">Your answer: <strong>{opt(sel)}</strong></p>{cor != null && <p className="text-sm">Correct answer: <strong className="text-success">{opt(cor)}</strong></p>}{r.explanation && <p className="text-sm text-muted-foreground">{r.explanation}</p>}</article>; })}</div>{history}</>;
}

// ---------- Assignment ----------
export function AssignmentPage({ courseId, assignmentId }: { courseId: string; assignmentId: string }) { return <Workspace role="STUDENT"><Assignment courseId={courseId} assignmentId={assignmentId} /></Workspace>; }
const stateTone = { SUBMITTED: 'primary', PENDING_REVIEW: 'warning', GRADED: 'success', RESUBMISSION_REQUESTED: 'danger' } as const;
const stateLabel = { SUBMITTED: 'Submitted', PENDING_REVIEW: 'Pending review', GRADED: 'Graded', RESUBMISSION_REQUESTED: 'Resubmission requested' } as const;
function Assignment({ courseId, assignmentId }: { courseId: string; assignmentId: string }) {
  const qc = useQueryClient();
  const a = useQuery({ queryKey: ['assignment', courseId, assignmentId], retry: false, queryFn: async () => pick<any>(await api(`/courses/${courseId}/assignments/${assignmentId}`), 'assignment') });
  const subs = useQuery({ queryKey: ['submissions', courseId, assignmentId], queryFn: async () => pickList(await api(`/courses/${courseId}/assignments/${assignmentId}/submissions`), 'submissions').map(toSubmission) });
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [busy, setBusy] = useState(false);
  if (a.isLoading) return <Loading />;
  if (a.error) return <ErrorBox message={errorStatus(a.error) === 403 ? 'This assignment is available to enrolled students only.' : errorText(a.error)} onRetry={() => a.refetch()} />;
  const list = [...(subs.data ?? [])].sort((x: any, y: any) => Number(y.version ?? 0) - Number(x.version ?? 0));
  const latest = list[0]; const st = latest ? submissionState(latest) : undefined; const allowed = canSubmit(latest);
  const max = a.data?.maxMarks ?? a.data?.maximumMarks ?? 100; const due = a.data?.dueDate;
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setErr(''); setOk('');
    const file = f.get('file'); if (file instanceof File && file.size) { const v = validSubmissionFile(file); if (v) { setErr(v); return; } } else f.delete('file');
    if (!String(f.get('writtenAnswer') ?? '').trim()) f.delete('writtenAnswer'); if (!String(f.get('projectUrl') ?? '').trim()) f.delete('projectUrl');
    if (![...f.keys()].length) { setErr('Add a written answer, a project URL, or a file.'); return; }
    setBusy(true); try { await api(`/courses/${courseId}/assignments/${assignmentId}/submissions`, { body: f }); form.reset(); setOk('Submitted. Your instructor will review it soon.'); await qc.invalidateQueries({ queryKey: ['submissions', courseId, assignmentId] }); void qc.invalidateQueries({ queryKey: ['eligibility', courseId] }); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  };
  return <><PageHeading eyebrow="ASSIGNMENT" title={a.data?.title ?? 'Assignment'} description={`Due ${fmtDate(due)} · ${max} marks`} action={st ? <Status tone={stateTone[st]}>{stateLabel[st]}</Status> : <Status>Not submitted</Status>} />
    <div className="two-col"><section className="form-shell"><h2 className="text-lg">Instructions</h2><p className="text-sm text-muted-foreground whitespace-pre-line">{a.data?.instructions ?? a.data?.description}</p>
      {latest && (latest.marks != null || latest.feedback) && <div className={`notice mt-4 ${st === 'RESUBMISSION_REQUESTED' ? 'notice-danger' : 'notice-success'}`}><FileText size={18} /><div><strong>{st === 'RESUBMISSION_REQUESTED' ? 'Resubmission requested' : 'Instructor feedback'}</strong>{latest.marks != null && <p>Marks: <strong>{latest.marks} / {max}</strong></p>}{latest.feedback && <p>{latest.feedback}</p>}</div></div>}</section>
      <section className="form-shell"><h2 className="text-lg">{latest ? 'Submit a new version' : 'Your submission'}</h2>
        {!allowed ? <Notice tone={st === 'GRADED' ? 'success' : 'warning'}>{st === 'GRADED' ? 'Your submission has been graded. Resubmission is only available if your instructor requests it.' : 'Your latest submission is awaiting review. You can submit again if your instructor requests changes.'}</Notice>
          : <form onSubmit={onSubmit}>{err && <ErrorBox message={err} />}{ok && <Notice tone="success">{ok}</Notice>}<label className="field"><span>Written answer (optional)</span><textarea name="writtenAnswer" rows={5} /></label><label className="field"><span>Project URL (optional)</span><input name="projectUrl" type="url" placeholder="https://" /></label><label className="field"><span>File (optional)</span><input name="file" type="file" accept={ALLOWED_SUBMISSION_TYPES.join(',')} /><small className="text-muted-foreground">PDF, DOCX, ZIP, PNG, JPG/JPEG · Maximum {MAX_UPLOAD_MB} MB</small></label>{due && new Date(due) < new Date() && <p className="text-xs text-warning mb-3">The due date has passed — this submission will be marked late.</p>}<Button type="submit" disabled={busy}><Upload />{busy ? 'Uploading…' : 'Submit assignment'}</Button></form>}</section></div>
    <section className="mt-10"><h2 className="text-lg">Submission history</h2>{subs.isLoading ? <Loading rows={1} /> : subs.error ? <ErrorBox message={errorText(subs.error)} /> : !list.length ? <Empty title="No submissions yet" description="Your submitted versions will appear here." /> : <div className="table-wrap"><table><thead><tr><th>Version</th><th>Submitted</th><th>Status</th><th>Marks</th><th>Files</th></tr></thead><tbody>{list.map((s: any, n: number) => { const ss = submissionState(s); return <tr key={s._id ?? n}><td>v{s.version ?? list.length - n}</td><td>{fmtDate(s.createdAt ?? s.submittedAt)}{(s.isLate || s.late) && <> <Status tone="warning">Late</Status></>}</td><td><Status tone={stateTone[ss]}>{stateLabel[ss]}</Status></td><td>{s.marks != null ? `${s.marks} / ${max}` : '—'}</td><td className="flex gap-2">{s.projectUrl && <a className="text-primary text-xs" href={s.projectUrl} target="_blank" rel="noreferrer">Project</a>}{s.fileUrl && <a className="text-primary text-xs inline-flex gap-1" href={s.fileUrl} target="_blank" rel="noreferrer"><Download size={12} />File</a>}</td></tr>; })}</tbody></table></div>}</section></>;
}
