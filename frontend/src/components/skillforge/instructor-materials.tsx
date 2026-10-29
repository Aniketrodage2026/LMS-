import { useId, useRef, useState, type FormEvent } from 'react';
import { FileText, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useInstructorMaterials, useMaterialActions, useMaterialLectures } from '@/lib/api/hooks';
import { materialFailureMessages, validMaterialFile, type InstructorMaterial } from '@/lib/api/models';
import { presentApiError } from '@/lib/errors/present';
import { Empty, ErrorGuidance, QueryState, Status, useErrorContext } from './shared';

const statusLabels = { PROCESSING: 'Processing', READY: 'Ready', PUBLISHED: 'Published', FAILED: 'Failed' } as const;
const statusTones = { PROCESSING: 'warning', READY: 'neutral', PUBLISHED: 'success', FAILED: 'danger' } as const;

export function InstructorMaterials({ courseId }: { courseId: string }) {
  const list = useInstructorMaterials(courseId); const lectures = useMaterialLectures(courseId);
  const { upload, update } = useMaterialActions(courseId); const context = useErrorContext({ courseId });
  const [title, setTitle] = useState(''); const [lectureId, setLectureId] = useState('');
  const [file, setFile] = useState<File | null>(null); const [validation, setValidation] = useState('');
  const [notice, setNotice] = useState(''); const fileRef = useRef<HTMLInputElement>(null); const locked = useRef(false);
  const id = useId(); const busy = upload.isPending || update.isPending;
  const refresh = () => { void list.refetch(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || locked.current) return;
    upload.reset(); update.reset(); setNotice('');
    const invalid = !title.trim() ? 'Enter a title for this material.' : !file ? 'Choose a PDF file to upload.' : validMaterialFile(file);
    if (invalid) { setValidation(invalid); return; }
    if (lectureId && !lectures.data?.some(lecture => lecture.id === lectureId)) { setValidation('Choose a lecture from this course.'); return; }
    setValidation(''); locked.current = true;
    try {
      await upload.mutateAsync({ title, file: file!, ...(lectureId ? { lectureId } : {}) });
      setTitle(''); setFile(null); if (fileRef.current) fileRef.current.value = '';
      setNotice('PDF prepared. Review its status below and publish it when it is ready for students.');
    } catch { /* The safe error retains the selected file and entered title. */ }
    finally { locked.current = false; }
  };
  const change = async (material: InstructorMaterial, action: 'publish' | 'unpublish' | 'retry' | 'delete') => {
    if (busy || locked.current) return;
    if (action === 'delete' && !confirm(`Delete “${material.title}”? Its PDF and tutor sources will be removed.`)) return;
    locked.current = true; setValidation(''); setNotice(''); upload.reset(); update.reset();
    try { await update.mutateAsync({ materialId: material.id, action }); setNotice('Material updated. The latest status is shown below.'); }
    catch { /* Keep server state authoritative; refresh runs even after a failure. */ }
    finally { locked.current = false; }
  };
  return <div className="grid gap-6 mt-6">
    <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby={`${id}-upload`}>
      <h2 id={`${id}-upload`} className="text-lg flex gap-2 items-center"><Upload size={18} aria-hidden="true" />Add study material</h2>
      <p id={`${id}-constraints`} className="text-sm text-muted-foreground">PDF only · 10 MB maximum · up to 100 pages with selectable text. Scanned images cannot be read yet.</p>
      <p className="text-sm text-muted-foreground">Upload material you are allowed to share with enrolled students.</p>
      <form onSubmit={submit} aria-describedby={`${id}-constraints`}>
        <fieldset disabled={busy} className="grid gap-4 min-w-0">
          <label className="field"><span>Material title</span><input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></label>
          <label className="field"><span>Material scope</span><select value={lectureId} onChange={event => setLectureId(event.target.value)} disabled={busy || !lectures.data || Boolean(lectures.error)}><option value="">Whole course</option>{lectures.data?.map(lecture => <option key={lecture.id} value={lecture.id}>{lecture.title}</option>)}</select></label>
          {lectures.isLoading && <p className="text-sm text-muted-foreground" role="status">Loading course lectures…</p>}
          {lectures.error && <ErrorGuidance error={presentApiError(lectures.error, context)} onRetry={() => { void lectures.refetch(); }} />}
          <label className="field"><span>PDF file</span><input ref={fileRef} type="file" accept=".pdf,application/pdf" onChange={event => { setFile(event.target.files?.[0] ?? null); setValidation(''); }} /></label>
          <Button type="submit" className="justify-self-start" disabled={busy}>{upload.isPending ? 'Uploading and preparing…' : 'Upload PDF'}</Button>
        </fieldset>
      </form>
    </section>
    {validation && <ErrorGuidance error={validation} />}
    {(upload.error || update.error) && <ErrorGuidance error={presentApiError(upload.error ?? update.error, context)} onRetry={refresh} />}
    <p role="status" aria-live="polite" className={notice ? 'text-sm text-success mb-0' : 'sr-only'}>{notice}</p>
    <section aria-labelledby={`${id}-list`}>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4"><h2 id={`${id}-list`} className="text-lg mb-0">Course materials</h2><Button type="button" variant="outline" size="sm" onClick={refresh} disabled={busy || list.isFetching}><RefreshCw aria-hidden="true" />Refresh status</Button></div>
      <p className="text-sm text-muted-foreground">Only published materials can be downloaded or used by the student tutor. Refresh to check a processing material.</p>
      <QueryState q={list} errorContext={context} isEmpty={data => data.length === 0} empty={<Empty title="No study materials yet" description="Upload a PDF, then publish it when it is ready." />}>
        {materials => <div className="grid gap-3">{materials.map(material => <article key={material.id} aria-label={material.title} className="rounded-xl border bg-card p-5 grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-base mb-1 break-words flex gap-2"><FileText size={18} className="shrink-0 text-primary" aria-hidden="true" />{material.title}</h3><p className="text-xs text-muted-foreground mb-0">{material.lectureId ? lectures.data?.find(lecture => lecture.id === material.lectureId)?.title ?? 'Course lecture' : 'Whole course'} · {material.pageCount ? `${material.pageCount} pages` : 'Page count pending'}</p></div><Status tone={statusTones[material.status]}>{statusLabels[material.status]}</Status></div>
          {material.status === 'FAILED' && <p className="text-sm text-destructive mb-0">{materialFailureMessages[material.failureCode ?? 'PROCESSING_FAILED']}</p>}
          <div className="flex flex-wrap gap-2">
            {material.status === 'READY' && <Button type="button" size="sm" disabled={busy} onClick={() => { void change(material, 'publish'); }}>Publish</Button>}
            {material.status === 'PUBLISHED' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void change(material, 'unpublish'); }}>Unpublish</Button>}
            {material.status === 'FAILED' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void change(material, 'retry'); }}>Retry</Button>}
            {material.status !== 'PROCESSING' && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void change(material, 'delete'); }}>Delete</Button>}
          </div>
        </article>)}</div>}
      </QueryState>
    </section>
  </div>;
}
