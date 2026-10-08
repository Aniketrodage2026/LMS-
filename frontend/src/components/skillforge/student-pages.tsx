import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient, useQueries } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Award, BookOpen, CheckCircle2, ClipboardList, Download, GraduationCap, Layers, LockKeyhole, Share2, ShieldCheck, ShoppingBag, TrendingUp, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, pick, pickList, errorText, errorStatus } from '@/lib/api/client';
import { useAuth } from '@/lib/api/auth';
import { useMyLearning, usePurchases, type LearningItem } from '@/lib/api/hooks';
import { fmtDate, inr, toUser, type Role } from '@/lib/api/models';
import { Workspace, PageHeading, Metric, ProgressBar, Status, CourseCard, Empty, QueryState, ErrorBox, Notice, Header, Footer, Loading } from './shared';

function LearningGrid({ items }: { items: LearningItem[] }) {
  return <div className="course-grid">{items.map(l => <CourseCard key={l.course.id} course={l.course} progress={l.progress} nextLabel={l.lastLectureTitle} />)}</div>;
}
const noCourses = <Empty title="Your next chapter is waiting" description="Find a course that sparks your curiosity and start your learning journey." action={<Button asChild><Link to="/courses">Find your first course <ArrowRight /></Link></Button>} />;

export function DashboardPage() {
  return <Workspace role="STUDENT"><Dashboard /></Workspace>;
}
function Dashboard() {
  const { user } = useAuth(); const q = useMyLearning(); const certs = useQuery({ queryKey: ['me', 'certificates'], queryFn: async () => pickList(await api('/me/certificates'), 'certificates') }); const purchases = usePurchases();
  const items = q.data ?? []; const current = [...items].filter(i => i.progress < 100).sort((a, b) => b.progress - a.progress)[0] ?? items[0];
  return <><PageHeading eyebrow="EVERY STEP COUNTS" title={`Welcome back, ${user?.name.split(' ')[0] ?? 'learner'}.`} description="A little progress today. A bigger possibility tomorrow." action={<Button variant="outline" asChild><Link to="/courses">Explore courses <ArrowUpRight /></Link></Button>} />
    <div className="metric-grid"><Metric icon={BookOpen} label="Enrolled courses" value={q.data ? String(items.length) : '—'} /><Metric icon={CheckCircle2} label="Completed" value={q.data ? String(items.filter(i => i.progress >= 100).length) : '—'} /><Metric icon={ShoppingBag} label="Verified purchases" value={purchases.data ? String(purchases.data.length) : '—'} /><Metric icon={Award} label="Certificates earned" value={certs.data ? String(certs.data.length) : '—'} /></div>
    <QueryState q={q} isEmpty={d => d.length === 0} empty={noCourses}>{() => <>{current && <div className="continue-band"><div className="continue-copy"><Status tone="success">PICK UP WHERE YOU LEFT OFF</Status><h2>{current.course.title}</h2><p>{current.lastLectureTitle ? `Last watched: ${current.lastLectureTitle}` : 'Start with your first lesson'}</p><ProgressBar value={current.progress} /><div className="flex justify-between max-w-[350px] text-[10px] mb-5"><span>{Math.round(current.progress)}% complete</span><span>{current.course.lectureCount} lessons</span></div><Button asChild><Link to="/learn/$courseId" params={{ courseId: current.course.id }} search={current.lastLectureId ? { lecture: current.lastLectureId } : {}}>Continue learning <ArrowRight /></Link></Button></div>{current.course.thumbnail && <img className="continue-image" src={current.course.thumbnail} alt="" width={1024} height={640} />}</div>}
      <div className="section-heading"><div><h2 className="!text-xl">My learning</h2><p>Small steps. Meaningful progress.</p></div><Link to="/student/$section" params={{ section: 'my-learning' }}>View all <ArrowUpRight size={14} /></Link></div><LearningGrid items={items.slice(0, 3)} />
      <div className="two-col mt-9"><div className="summary-block"><h3>Assessments</h3><p>Quizzes and assignments for your enrolled courses.</p><Button variant="link" asChild><Link to="/student/$section" params={{ section: 'assessments' }}>Your next steps <ArrowRight /></Link></Button></div><div className="summary-block"><h3>Certificates</h3><p>Check eligibility and claim what you’ve earned.</p><Button variant="link" asChild><Link to="/student/$section" params={{ section: 'certificates' }}>Your achievements <ArrowRight /></Link></Button></div></div></>}</QueryState></>;
}

export function StudentPage({ section }: { section: string }) {
  return <Workspace role="STUDENT">{section === 'my-learning' ? <MyLearning /> : section === 'purchases' ? <Purchases /> : section === 'assessments' ? <Assessments /> : section === 'certificates' ? <Certificates /> : section === 'profile' ? <Profile /> : <Empty title="Section not found" description="Choose a section from the navigation." />}</Workspace>;
}
function MyLearning() {
  const q = useMyLearning(); const [tab, setTab] = useState('All courses');
  return <><PageHeading title="My Learning" description="Every course you’ve enrolled in or purchased." /><div className="section-tabs">{['All courses', 'In progress', 'Completed'].map(t => <Button variant="ghost" key={t} className={t === tab ? 'selected' : ''} onClick={() => setTab(t)}>{t}</Button>)}</div>
    <QueryState q={q} isEmpty={d => d.length === 0} empty={noCourses}>{d => { const f = d.filter(c => tab === 'All courses' || (tab === 'Completed' ? c.progress >= 100 : c.progress < 100)); return f.length ? <LearningGrid items={f} /> : <Empty title="Nothing here yet" description={tab === 'Completed' ? 'Finish a course to see it here.' : 'All caught up.'} />; }}</QueryState></>;
}
function Purchases() {
  const q = usePurchases();
  return <><PageHeading title="Your learning investments." description="Verified one-time purchases. No subscriptions." />
    <QueryState q={q} isEmpty={d => d.length === 0} empty={<Empty title="No purchases yet" description="Paid courses you buy appear here after payment verification." action={<Button asChild><Link to="/courses">Browse courses</Link></Button>} />}>{d => <><div className="metric-grid"><Metric icon={ShoppingBag} label="Courses purchased" value={String(d.length)} /><Metric icon={TrendingUp} label="Total investment" value={inr(d.reduce((n: number, p: any) => n + Number(p.amount ?? p.course?.price ?? 0), 0))} /><Metric icon={BookOpen} label="Access" value="Lifetime" /><Metric icon={ShieldCheck} label="Purchase type" value="One-time" /></div>
      <div className="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>{d.map((p: any, i: number) => { const amount = Number(p.amount ?? p.course?.price ?? 0); const st = String(p.status ?? 'VERIFIED'); return <tr key={p._id ?? i}><td><strong>{p.course?.title ?? 'Course'}</strong><small>Order {p.razorpayOrderId ?? p.orderId ?? '—'}</small></td><td>{fmtDate(p.createdAt ?? p.purchasedAt)}</td><td>{inr(amount)}</td><td><Status tone={/VERIF|PAID|SUCCESS/i.test(st) ? 'success' : /PEND|CREAT/i.test(st) ? 'warning' : 'danger'}>{st.toLowerCase()}</Status></td><td><Button variant="ghost" size="icon" aria-label="Download receipt" onClick={() => { const url = URL.createObjectURL(new Blob([`SkillForge receipt\nCourse: ${p.course?.title ?? ''}\nOrder: ${p.razorpayOrderId ?? ''}\nPayment: ${p.razorpayPaymentId ?? ''}\nAmount: ${inr(amount)}\nStatus: ${st}\nOne-time purchase (Razorpay Test Mode)`], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = `skillforge-receipt-${i + 1}.txt`; a.click(); URL.revokeObjectURL(url); }}><Download /></Button></td></tr>; })}</tbody></table></div></>}</QueryState></>;
}
function Assessments() {
  const q = useMyLearning(); const courses = q.data ?? [];
  const lists = useQueries({ queries: courses.flatMap(l => [{ queryKey: ['quizzes', l.course.id], queryFn: async () => pickList(await api(`/courses/${l.course.id}/quizzes`), 'quizzes') }, { queryKey: ['assignments', l.course.id], queryFn: async () => pickList(await api(`/courses/${l.course.id}/assignments`), 'assignments') }]) });
  return <><PageHeading title="Put your skills to the test." description="Published quizzes and assignments for your active courses." />
    <QueryState q={q} isEmpty={d => d.length === 0} empty={noCourses}>{() => <div className="grid gap-8">{courses.map((l, i) => { const qz = lists[i * 2]; const as = lists[i * 2 + 1]; return <section key={l.course.id}><h2 className="text-lg mb-3">{l.course.title}</h2>{(qz?.isLoading || as?.isLoading) ? <Loading rows={1} /> : (qz?.error || as?.error) ? <ErrorBox message={errorText(qz?.error ?? as?.error)} /> : <div className="assessment-grid">{(qz?.data ?? []).map((z: any) => <article className="assessment-card" key={z._id ?? z.id}><div className="flex justify-between items-center"><span className="assessment-icon"><ClipboardList size={20} /></span><Status tone="primary">Quiz</Status></div><h3>{z.title}</h3><p>Pass mark {z.passMark ?? z.passingScore ?? 80}% · Unlimited attempts</p><Button variant="outline" asChild className="mt-5 w-full"><Link to="/quizzes/$courseId/$quizId" params={{ courseId: l.course.id, quizId: String(z._id ?? z.id) }}>Take quiz <ArrowRight /></Link></Button></article>)}{(as?.data ?? []).map((a: any) => <article className="assessment-card" key={a._id ?? a.id}><div className="flex justify-between items-center"><span className="assessment-icon"><Layers size={20} /></span><Status tone="warning">Due {fmtDate(a.dueDate)}</Status></div><h3>{a.title}</h3><p>{a.maxMarks ?? a.maximumMarks ?? 100} marks</p><Button variant="outline" asChild className="mt-5 w-full"><Link to="/assignments/$courseId/$assignmentId" params={{ courseId: l.course.id, assignmentId: String(a._id ?? a.id) }}>View assignment <ArrowRight /></Link></Button></article>)}{!(qz?.data?.length) && !(as?.data?.length) && <p className="text-sm text-muted-foreground">No published assessments for this course yet.</p>}</div>}</section>; })}</div>}</QueryState></>;
}

function Eligibility({ item }: { item: LearningItem }) {
  const qc = useQueryClient(); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['eligibility', item.course.id], queryFn: async () => pick<any>(await api(`/courses/${item.course.id}/certificate/eligibility`), 'eligibility') ?? {} });
  const e = q.data ?? {};
  const num = (...k: string[]) => { for (const x of k) { const v = e?.[x] ?? e?.checks?.[x] ?? e?.requirements?.[x]; if (v != null) return typeof v === 'object' ? v : v; } return undefined; };
  const flag = (v: any) => (typeof v === 'object' && v ? Boolean(v.met ?? v.passed ?? v.ok) : Boolean(v));
  const completion = num('lectureCompletion', 'completionPercentage', 'completion'); const avg = num('assessmentAverage', 'overallAverage', 'averageScore');
  const checks = [
    { t: 'At least 80% lecture completion', d: completion != null ? `${Math.round(typeof completion === 'object' ? completion.value ?? 0 : completion)}% completed` : `${Math.round(item.progress)}% completed`, ok: flag(num('lectureCompletionMet', 'completionMet')) || (typeof completion === 'number' ? completion >= 80 : item.progress >= 80) },
    { t: 'Pass every published quiz', d: '', ok: flag(num('allQuizzesPassed', 'quizzesPassed', 'quizzes')) },
    { t: 'Receive a grade for every published assignment', d: '', ok: flag(num('allAssignmentsGraded', 'assignmentsGraded', 'assignments')) },
    { t: 'At least 80% overall assessment average', d: avg != null && typeof avg === 'number' ? `${Math.round(avg)}% average` : '', ok: flag(num('assessmentAverageMet', 'averageMet')) || (typeof avg === 'number' && avg >= 80) },
  ];
  const eligible = e.eligible === true || e.isEligible === true; const claimed = e.claimed === true || Boolean(e.certificate);
  const claim = async () => { setBusy(true); setErr(''); try { await api(`/courses/${item.course.id}/certificate/claim`, { method: 'POST' }); await Promise.all([qc.invalidateQueries({ queryKey: ['eligibility', item.course.id] }), qc.invalidateQueries({ queryKey: ['me', 'certificates'] })]); } catch (x) { if (errorStatus(x) === 409) await qc.invalidateQueries({ queryKey: ['me', 'certificates'] }); setErr(errorText(x)); } finally { setBusy(false); } };
  return <article className="summary-block"><div className="flex justify-between items-center mb-3"><h3 className="m-0">{item.course.title}</h3><Status tone={claimed ? 'success' : eligible ? 'success' : 'neutral'}>{claimed ? 'Claimed' : eligible ? 'Eligible' : 'Locked'}</Status></div>
    {q.isLoading ? <Loading rows={1} /> : q.error ? <ErrorBox message={errorText(q.error)} onRetry={() => q.refetch()} /> : <>{checks.map(c => <div className="checklist-item" key={c.t}>{c.ok ? <CheckCircle2 size={21} className="text-success" /> : <LockKeyhole size={21} className="text-muted-foreground" />}<div><strong>{c.t}</strong>{c.d && <p>{c.d}</p>}</div></div>)}
      {err && <ErrorBox message={err} />}
      {eligible && !claimed ? <Button className="mt-4" disabled={busy} onClick={claim}>{busy ? 'Claiming…' : 'Claim certificate'} <Award /></Button> : !claimed && <Button className="mt-4" variant="outline" asChild><Link to="/learn/$courseId" params={{ courseId: item.course.id }}>Keep learning to unlock</Link></Button>}</>}</article>;
}
function Certificates() {
  const learning = useMyLearning(); const certs = useQuery({ queryKey: ['me', 'certificates'], queryFn: async () => pickList(await api('/me/certificates'), 'certificates') });
  return <><PageHeading title="Your progress. Recognized." description="Certificates are earned through learning and assessment — eligibility is confirmed by SkillForge." />
    <div className="section-heading"><div><h2 className="!text-xl">Earned achievements</h2></div></div>
    <QueryState q={certs} isEmpty={d => d.length === 0} empty={<Empty title="No certificates yet" description="Meet every requirement for a course to claim your first certificate." />}>{d => <div className="certificate-layout">{d.map((c: any, i: number) => <CertificateCard key={c._id ?? i} cert={c} />)}</div>}</QueryState>
    <div className="section-heading mt-12"><div><h2 className="!text-xl">Eligibility</h2><p>Your certificate is earned, not just issued.</p></div></div>
    <QueryState q={learning} isEmpty={d => d.length === 0} empty={noCourses}>{d => <div className="two-col">{d.map(l => <Eligibility key={l.course.id} item={l} />)}</div>}</QueryState></>;
}
const certFields = (c: any) => ({ name: c.learnerName ?? c.user?.name ?? c.student?.name ?? 'Learner', course: c.courseTitle ?? c.course?.title ?? 'Course', number: c.certificateNumber ?? c.number ?? c._id ?? '—', issued: c.issuedAt ?? c.issueDate ?? c.createdAt, token: c.verificationToken ?? c.token ?? c.certificateNumber });
export function CertificateCard({ cert }: { cert: any }) {
  const f = certFields(cert); const [shared, setShared] = useState(false);
  const link = typeof window !== 'undefined' ? `${window.location.origin}/verify/${encodeURIComponent(f.token)}` : '';
  const esc = (s: string) => String(s).replace(/[<>&"]/g, '');
  return <article className="certificate-card"><div className="certificate-inner"><GraduationCap size={36} /><div className="eyebrow">SKILLFORGE · CERTIFICATE OF ACHIEVEMENT</div><p>This certificate is proudly presented to</p><h2>{f.name}</h2><p>for successfully completing</p><h3>{f.course}</h3><p>Issued {fmtDate(f.issued)}</p><span className="certificate-seal"><ShieldCheck size={16} /> Verified learning. Meaningful achievement.</span><div className="certificate-number">{f.number}</div></div>
    <div className="certificate-actions"><Button variant="outline" size="sm" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(`<html><head><title>SkillForge certificate</title></head><body style="font-family:sans-serif;text-align:center;padding:80px;border:8px double #4f46e5"><h1>SkillForge</h1><h2>Certificate of Achievement</h2><p>Presented to</p><h1>${esc(f.name)}</h1><p>for completing</p><h2>${esc(f.course)}</h2><p>Issued ${esc(fmtDate(f.issued))} · ${esc(f.number)}</p><p>Verify: ${esc(link)}</p></body></html>`); w.document.close(); w.print(); } }}><Download />Download / PDF</Button><Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setShared(true); } catch { setShared(false); } }}><Share2 />{shared ? 'Link copied' : 'Share'}</Button></div></article>;
}

export function Profile() {
  const { user, setUser } = useAuth(); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [pwMsg, setPwMsg] = useState(''); const [pwErr, setPwErr] = useState(''); const [busy, setBusy] = useState(false);
  if (!user) return null;
  return <><PageHeading title="Make yourself at home." description="Your profile and account security." /><div className="form-shell"><div className="flex gap-4 items-center mb-8">{user.avatar ? <img src={user.avatar} alt="" className="avatar !w-16 !h-16 object-cover" /> : <span className="avatar !w-16 !h-16 !text-xl">{user.name.slice(0, 2).toUpperCase()}</span>}<div><h2 className="text-lg mb-1">{user.name}</h2><Status tone="primary">{user.role.toLowerCase()}</Status></div></div>
    {err && <ErrorBox message={err} />}{msg && <Notice tone="success">{msg}</Notice>}
    <form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); const av = f.get('avatar'); if (av instanceof File && !av.size) f.delete('avatar'); setBusy(true); setErr(''); setMsg(''); try { const j = await api('/auth/update', { method: 'PUT', body: f }); const u = toUser(pick(j, 'user')); if (u?.id) setUser(u); else setUser({ ...user, name: String(f.get('fullName')) }); setMsg('Your profile has been updated.'); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }}>
      <div className="form-grid"><label className="field"><span>Full name</span><input name="fullName" required defaultValue={user.name} /></label><label className="field"><span>Email address</span><input type="email" value={user.email} readOnly aria-readonly /></label></div><label className="field"><span>Profile photo</span><input name="avatar" type="file" accept="image/png,image/jpeg,image/webp" /></label><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button></form>
    <h2 className="text-lg mt-10 mb-4">Change password</h2>{pwErr && <ErrorBox message={pwErr} />}{pwMsg && <Notice tone="success">{pwMsg}</Notice>}
    <form onSubmit={async e => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setPwErr(''); setPwMsg(''); if (f.get('newPassword') !== f.get('confirm')) { setPwErr('New passwords don’t match.'); return; } try { await api('/auth/changepassword', { body: { oldPassword: f.get('oldPassword'), newPassword: f.get('newPassword') } }); form.reset(); setPwMsg('Your password has been changed.'); } catch (x) { setPwErr(errorText(x)); } }}><div className="form-grid"><label className="field"><span>Current password</span><input name="oldPassword" type="password" autoComplete="current-password" required /></label><label className="field"><span>New password</span><input name="newPassword" type="password" minLength={8} autoComplete="new-password" required /></label></div><label className="field"><span>Confirm new password</span><input name="confirm" type="password" minLength={8} required /></label><Button type="submit" variant="outline">Update password</Button></form></div></>;
}
export function ProfilePage({ role }: { role: Role }) { return <Workspace role={role}><Profile /></Workspace>; }

export function VerificationPage({ token }: { token?: string | undefined }) {
  const [value, setValue] = useState(token ?? '');
  const q = useQuery({ queryKey: ['verify', token], enabled: Boolean(token), retry: false, queryFn: async () => pick<any>(await api(`/certificates/verify/${encodeURIComponent(token!)}`), 'certificate') });
  const valid = q.data && (q.data.valid !== false) && String(q.data.status ?? 'VALID').toUpperCase() !== 'REVOKED';
  const f = q.data ? certFields(q.data) : null;
  return <><Header /><main className="wide"><div className="verification">
    {!token ? <><Search size={48} /><h1 className="mt-5">Verify a certificate.</h1><p className="text-sm text-muted-foreground">Enter the verification code from a SkillForge certificate.</p><form className="hero-search mt-6" onSubmit={e => { e.preventDefault(); if (value.trim()) window.location.assign(`/verify/${encodeURIComponent(value.trim())}`); }}><input aria-label="Verification code" value={value} onChange={e => setValue(e.target.value)} placeholder="Verification code" /><Button type="submit">Verify</Button></form></>
      : q.isLoading ? <Loading rows={2} label="Verifying certificate" /> : valid && f ? <><ShieldCheck size={58} /><Status tone="success">Valid certificate</Status><h1 className="mt-5">Achievement, verified.</h1><dl>{[['Certificate number', f.number], ['Learner name', f.name], ['Course title', f.course], ['Issue date', fmtDate(f.issued)], ['Issuer', 'SkillForge'], ['Status', 'Valid']].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>
        : <><LockKeyhole size={58} /><Status tone="danger">Certificate not found</Status><h1 className="mt-5">We couldn’t verify this certificate.</h1><p className="text-sm text-muted-foreground">{q.error && errorStatus(q.error) !== 404 ? errorText(q.error) : 'Check the verification code and try again.'}</p><Button variant="outline" asChild><Link to="/verify">Try another code</Link></Button></>}
  </div></main><Footer /></>;
}
