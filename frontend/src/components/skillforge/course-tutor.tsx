import { useId, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useCourseTutor, useMaterialLectures, useStudentMaterials } from '@/lib/api/hooks';
import { materialDownloadHref, type AiActiveCourse, type StudentMaterial } from '@/lib/api/models';
import { presentApiError } from '@/lib/errors/present';
import { ErrorGuidance, QueryState, Status } from './shared';

const fieldClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring';
const outcomeCopy = {
  NO_RELEVANT_SOURCE: 'I could not find an answer in the published material for this scope. Try a more specific question or choose a different lecture.',
  RAG_UNAVAILABLE: 'The materials tutor is temporarily unavailable. You can still read the published PDFs and try your question again shortly.',
  RAG_LIMIT_REACHED: 'The daily materials tutor limit has been reached. Continue with the published PDFs and try again tomorrow.',
} as const;

function DownloadLink({ material, courseId }: { material: StudentMaterial; courseId: string }) {
  const href = materialDownloadHref(material.downloadEndpoint, courseId, material.id);
  // Plain navigation only: the server checks access before redirecting. Never fetch the redirect into state.
  return href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 underline underline-offset-4 text-sm focus-visible:outline focus-visible:outline-ring" aria-label={`Download ${material.title}`}><Download size={14} aria-hidden="true" />Download PDF</a> : null;
}

function TutorQuestion({ courseId, lectureId, materials }: { courseId: string; lectureId: string; materials: StudentMaterial[] }) {
  const tutor = useCourseTutor(); const [question, setQuestion] = useState(''); const locked = useRef(false); const id = useId();
  const context = { courseId, returnTo: '/dashboard', workspaceRole: 'STUDENT' as const };
  const ask = async (event?: FormEvent) => {
    event?.preventDefault(); if (locked.current || tutor.isPending || !materials.length || !question.trim() || question.length > 2000) return;
    locked.current = true; tutor.reset();
    try { await tutor.mutateAsync({ courseId, ...(lectureId ? { lectureId } : {}), question }); }
    catch { /* Keep the question for an explicit retry. */ }
    finally { locked.current = false; }
  };
  return <div className="grid gap-4">
    <form className="grid gap-3" onSubmit={ask}>
      <label htmlFor={`${id}-question`} className="text-sm font-medium">Question about course materials</label>
      <textarea id={`${id}-question`} className={fieldClass} rows={3} maxLength={2000} value={question} onChange={event => setQuestion(event.target.value)} disabled={tutor.isPending} required aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground mb-0">Ask about the published PDFs in this scope. Up to 2000 characters. Check the cited pages before relying on an answer.</p>
      <Button type="submit" className="justify-self-start" disabled={!materials.length || !question.trim() || question.length > 2000 || tutor.isPending}>{tutor.isPending ? 'Reading materials…' : 'Ask materials tutor'}</Button>
    </form>
    {tutor.error && <ErrorGuidance error={presentApiError(tutor.error, context)} onRetry={() => { void ask(); }} />}
    <div aria-live="polite" aria-atomic="true" aria-busy={tutor.isPending}>
      {tutor.isPending && <p className="text-sm text-muted-foreground">Looking for relevant passages in the published PDFs…</p>}
      {tutor.data && (tutor.data.outcome === 'ANSWERED' ? <div className="rounded-lg bg-muted p-4 grid gap-3">
        <Status tone="primary">Course materials</Status><p className="text-sm whitespace-pre-wrap break-words mb-0">{tutor.data.answer}</p>
        {tutor.data.citations.length > 0 && <div className="grid gap-2"><h4 className="text-sm font-semibold mb-0">Sources</h4>{tutor.data.citations.map((citation, index) => {
          const material = materials.find(item => item.id === citation.materialId);
          return <div key={`${citation.materialId}-${index}`} className="rounded-md border bg-background p-3"><p className="font-medium text-sm break-words mb-1">{citation.title}</p><p className="text-xs text-muted-foreground mb-0">{citation.pageStart === citation.pageEnd ? `Page ${citation.pageStart}` : `Pages ${citation.pageStart}–${citation.pageEnd}`}</p>{!material && <p className="text-xs text-muted-foreground mt-1 mb-0">Refresh the materials list to check source availability.</p>}</div>;
        })}</div>}
      </div> : <p className="text-sm rounded-lg bg-muted p-4 mb-0">{outcomeCopy[tutor.data.outcome]}</p>)}
    </div>
  </div>;
}

function SelectedCourseMaterials({ courseId }: { courseId: string }) {
  const materials = useStudentMaterials(courseId); const lectures = useMaterialLectures(courseId); const [lectureId, setLectureId] = useState(''); const id = useId();
  const selectedLecture = lectures.data?.some(lecture => lecture.id === lectureId) ? lectureId : '';
  const context = { courseId, workspaceRole: 'STUDENT' as const };
  return <div className="grid gap-4">
    <div className="grid gap-2 max-w-xl"><label htmlFor={`${id}-lecture`} className="text-sm font-medium">Lecture for materials</label><select id={`${id}-lecture`} value={selectedLecture} onChange={event => setLectureId(event.target.value)} className={fieldClass} disabled={!lectures.data || Boolean(lectures.error)}><option value="">Whole course</option>{lectures.data?.map(lecture => <option key={lecture.id} value={lecture.id}>{lecture.title}</option>)}</select><p className="text-xs text-muted-foreground mb-0">A lecture filter includes its PDFs and any whole-course study materials.</p></div>
    {lectures.error && <ErrorGuidance error={presentApiError(lectures.error, context)} onRetry={() => { void lectures.refetch(); }} />}
    <QueryState q={materials} errorContext={context} rows={1}>{list => {
      const scoped = list.filter(material => !selectedLecture || !material.lectureId || material.lectureId === selectedLecture);
      return <>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base mb-0">Published PDFs</h3><Button type="button" variant="ghost" size="sm" disabled={materials.isFetching} onClick={() => { void materials.refetch(); }}>Refresh materials</Button></div>
        {scoped.length ? <ul className="list-none pl-0 grid gap-2 mb-0">{scoped.map(material => <li key={material.id} className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="font-medium text-sm break-words mb-1">{material.title}</p><p className="text-xs text-muted-foreground mb-0">{material.pageCount} pages</p></div><DownloadLink material={material} courseId={courseId} /></li>)}</ul> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground mb-0">No published PDF study material is available for this scope yet. Your instructor can add it later.</p>}
        <TutorQuestion key={`${courseId}:${selectedLecture}:${scoped.map(item => item.id).join(',')}`} courseId={courseId} lectureId={selectedLecture} materials={scoped} />
      </>;
    }}</QueryState>
  </div>;
}

export function CourseTutorPanel({ activeCourses }: { activeCourses: AiActiveCourse[] }) {
  const [courseId, setCourseId] = useState(''); const id = useId();
  const selected = activeCourses.some(item => item.course.id === courseId) ? courseId : '';
  return <section aria-labelledby={`${id}-title`} className="mt-6"><Card className="shadow-none"><CardHeader><h2 id={`${id}-title`} className="text-xl flex gap-2 items-center mb-0"><BookOpen size={22} className="text-primary" aria-hidden="true" />Ask course materials</h2><p className="text-sm text-muted-foreground mb-0">Answers from published PDF study materials, with page references. Choose one of your active courses to begin.</p></CardHeader><CardContent className="grid gap-4">
    {activeCourses.length ? <><div className="grid gap-2 max-w-xl"><label htmlFor={`${id}-course`} className="text-sm font-medium">Course for materials</label><select id={`${id}-course`} value={selected} onChange={event => setCourseId(event.target.value)} className={fieldClass}><option value="">Choose an active course</option>{activeCourses.map(item => <option key={item.course.id} value={item.course.id}>{item.course.title}</option>)}</select></div>{selected && <SelectedCourseMaterials key={selected} courseId={selected} />}</> : <p className="text-sm text-muted-foreground mb-0">Your active courses will appear here when available in My Learning.</p>}
  </CardContent></Card></section>;
}
