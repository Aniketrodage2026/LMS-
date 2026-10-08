import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BarChart3, BookOpen, CreditCard, ShieldCheck, Users, Clock3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorText } from '@/lib/api/client';
import { Workspace, PageHeading, Status, ErrorBox, Notice, Empty } from './shared';
import { ProfilePage } from './student-pages';

const placeholders: Record<string, { title: string; desc: string; icon: typeof Users }> = {
  users: { title: 'Users', desc: 'Search learners, instructors, and admins.', icon: Users },
  courses: { title: 'Course moderation', desc: 'Review and approve courses before they go live.', icon: BookOpen },
  payments: { title: 'Payment reports', desc: 'Verified purchases, refunds, and revenue by course.', icon: CreditCard },
  analytics: { title: 'Analytics', desc: 'Enrolments, completion rates, and certificate trends.', icon: BarChart3 },
};
export function AdminPage({ section = 'overview' }: { section?: string | undefined }) {
  if (section === 'profile') return <ProfilePage role="ADMIN" />;
  return <Workspace role="ADMIN">{section === 'roles' ? <Roles /> : placeholders[section] ? <ComingNext {...placeholders[section]!} /> : <Overview />}</Workspace>;
}
function Overview() {
  return <><PageHeading eyebrow="PLATFORM ADMIN" title="Keep SkillForge running smoothly." description="Role management is live. More admin tools are on the way." />
    <div className="assessment-grid"><article className="assessment-card"><div className="flex justify-between"><span className="assessment-icon"><ShieldCheck size={20} /></span><Status tone="success">Connected</Status></div><h3>Role management</h3><p>Set learner or instructor access.</p><Button className="w-full mt-5" asChild><Link to="/admin/$section" params={{ section: 'roles' }}>Manage roles</Link></Button></article>
      {Object.entries(placeholders).map(([k, p]) => <article className="assessment-card" key={k}><div className="flex justify-between"><span className="assessment-icon"><p.icon size={20} /></span><Status tone="warning">API coming next</Status></div><h3>{p.title}</h3><p>{p.desc}</p><Button variant="outline" className="w-full mt-5" asChild><Link to="/admin/$section" params={{ section: k }}>Preview</Link></Button></article>)}</div></>;
}
function ComingNext({ title, desc, icon: Icon }: { title: string; desc: string; icon: typeof Users }) {
  return <><PageHeading title={title} description={desc} action={<Status tone="warning"><Clock3 size={12} /> API coming next</Status>} /><div className="empty-state"><Icon size={38} /><h3>Not connected yet</h3><p>The backend doesn’t provide this data yet. This screen will light up once the API is available — nothing shown here is real.</p></div><div className="metric-grid mt-6 opacity-50" aria-hidden>{[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-muted rounded-lg" />)}</div></>;
}
function Roles() {
  const [userId, setUserId] = useState(''); const [role, setRole] = useState('INSTRUCTOR'); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState('');
  return <><PageHeading eyebrow="ROLE MANAGEMENT" title="Assign platform roles." description="Change a user’s role by their user ID. The server confirms every change." />
    <div className="form-shell max-w-[640px]">{err && <ErrorBox message={err} />}{ok && <Notice tone="success">{ok}</Notice>}
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(''); setOk(''); try { await api(`/admin/users/${encodeURIComponent(userId.trim())}/role`, { method: 'PATCH', body: { role } }); setOk(`Role updated to ${role.toLowerCase()}.`); setUserId(''); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }}>
        <label className="field"><span>User ID</span><input value={userId} onChange={e => setUserId(e.target.value)} required placeholder="e.g. 66f1c2…" /></label>
        <label className="field"><span>New role</span><select value={role} onChange={e => setRole(e.target.value)}><option value="STUDENT">Student</option><option value="INSTRUCTOR">Instructor</option></select></label>
        <Button type="submit" disabled={busy || !userId.trim()}>{busy ? 'Updating…' : 'Update role'}</Button></form>
      <p className="text-xs text-muted-foreground mt-4">A user list with search is coming next. Until then, find user IDs in your database or from the user.</p></div>
    <div className="mt-6"><Empty title="User directory — API coming next" description="Search and filter users here once the backend provides a user list." /></div></>;
}
