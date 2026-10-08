import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowRight, ArrowUpRight, Award, BookOpen, ChevronRight, CircleHelp, ClipboardList, Clock3, GraduationCap, LayoutDashboard, Layers, LockKeyhole, LogOut, Menu, Play, Plus, Search, ShieldCheck, ShoppingBag, UserRound, Users, X, AlertTriangle, RefreshCw, BarChart3, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/api/auth';
import { homeFor, inr, type ApiCourse, type Role } from '@/lib/api/models';
import fallbackCover from '@/assets/learning-studio.jpg';

export function Brand() { return <Link to="/" className="brand" aria-label="SkillForge home"><span className="brand-symbol"><GraduationCap size={24} /></span><span>Skill<span className="text-primary">Forge</span><span className="brand-dot">.</span></span></Link>; }

export function Header() {
  const [open, setOpen] = useState(false);
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();
  return <header className="site-header"><div className="wide header-inner"><Brand />
    <nav className={open ? 'public-nav mobile-open' : 'public-nav'}><Link to="/courses" onClick={() => setOpen(false)}>Explore courses</Link><Link to="/courses" search={{ free: true }} onClick={() => setOpen(false)}>Learn for free <span className="nav-new">FREE</span></Link><Link to="/verify" onClick={() => setOpen(false)}>Verify a certificate</Link></nav>
    <div className="header-actions">
      {status === 'loading' ? <span className="h-9 w-28 bg-muted rounded-md animate-pulse" aria-label="Checking your session" /> : user ? <>
        <Button variant="ghost" asChild><a href={homeFor(user.role)} onClick={e => { e.preventDefault(); navigate({ to: homeFor(user.role) }); }}>{user.role === 'STUDENT' ? 'My learning' : user.role === 'INSTRUCTOR' ? 'Instructor workspace' : 'Admin'}</a></Button>
        <Button variant="outline" onClick={async () => { await logout(); navigate({ to: '/login', replace: true }); }}><LogOut />Sign out</Button>
      </> : <><Button variant="ghost" asChild><Link to="/login">Log in</Link></Button><Button asChild><Link to="/register">Get started <ArrowUpRight /></Link></Button></>}
      <Button variant="ghost" size="icon" className="mobile-menu" aria-label="Toggle navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</Button>
    </div></div></header>;
}
export function Footer() { return <footer className="site-footer"><div className="wide footer-top"><div><Brand /><p>Real skills. Real progress. Your next chapter.</p></div><div className="footer-links"><Link to="/courses">Explore courses</Link><Link to="/register">Create an account</Link><Link to="/verify">Verify a certificate</Link></div></div><div className="wide footer-bottom"><span>© 2026 SkillForge. All rights reserved.</span><span>Made for lifelong learners <span className="text-success">✦</span></span></div></footer>; }
export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'primary' | 'neutral' | 'danger' }) { return <span className={`status status-${tone}`}>{children}</span>; }
export function ProgressBar({ value }: { value: number }) { const v = Math.max(0, Math.min(100, Math.round(value || 0))); return <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}><div className="progress-fill" style={{ width: `${v}%` }} /></div>; }
export function Metric({ icon: Icon, label, value, note }: { icon: typeof BookOpen; label: string; value: string; note?: string | undefined }) { return <article className="metric"><span className="metric-icon"><Icon size={21} /></span><div><p>{label}</p><strong>{value}</strong>{note && <small>{note}</small>}</div></article>; }
export function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string | undefined | undefined; title: string; description?: string | undefined | undefined; action?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><BookOpen size={38} /><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Loading({ rows = 3, label = 'Loading' }: { rows?: number | undefined; label?: string | undefined }) { return <div aria-busy="true" aria-label={label} className="grid gap-4">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />)}</div>; }
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div role="alert" className="notice notice-danger"><AlertTriangle size={18} /><p className="flex-1">{message}</p>{onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw />Try again</Button>}</div>; }
export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'neutral' | 'danger' }) { return <div role="status" className={`notice ${tone !== 'neutral' ? `notice-${tone}` : ''}`}><ShieldCheck size={18} /><div>{children}</div></div>; }
/** Unified loading / error / empty / success renderer for a react-query result. */
export function QueryState<T>({ q, empty, isEmpty, children, rows }: { q: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; empty?: ReactNode; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode; rows?: number | undefined }) {
  if (q.isLoading) return <Loading rows={rows} />;
  if (q.error) return <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  if (q.data === undefined) return null;
  if (isEmpty?.(q.data)) return <>{empty}</>;
  return <>{children(q.data)}</>;
}

export function CourseCard({ course, progress, nextLabel }: { course: ApiCourse; progress?: number | undefined; nextLabel?: string | undefined }) {
  const learning = progress !== undefined;
  return <article className="course-card"><div className="course-image"><Link to="/courses/$courseId" params={{ courseId: course.id }}><img src={course.thumbnail ?? fallbackCover} alt={`${course.title} course cover`} loading="lazy" width={1024} height={640} /></Link>{course.isFree && <span className="course-tag">Free</span>}{!learning && <Button variant="secondary" size="sm" className="preview-button" asChild><Link to="/courses/$courseId" params={{ courseId: course.id }} search={{ preview: true }}><Play size={12} /> Preview</Link></Button>}</div>
    <div className="course-body"><div className="course-category"><span>{course.category}</span><span>{course.level}</span></div><Link to="/courses/$courseId" params={{ courseId: course.id }} className="course-title">{course.title}</Link><p className="course-instructor"><span className="avatar-tiny">{initials(course.instructorName)}</span>{course.instructorName}</p><div className="course-meta"><span><BookOpen size={13} />{course.lectureCount} lessons</span>{course.status && course.status !== 'PUBLISHED' && <Status tone="warning">{course.status}</Status>}</div>
      {learning ? <div className="learning-card-bottom"><div className="flex justify-between mb-2 text-xs"><span>Course progress</span><strong className="text-success">{Math.round(progress)}%</strong></div><ProgressBar value={progress} />{nextLabel && <p className="text-xs text-muted-foreground mt-3">Next: {nextLabel}</p>}<Button asChild className="w-full mt-3"><Link to="/learn/$courseId" params={{ courseId: course.id }}>{progress >= 100 ? 'Review course' : 'Continue learning'} <ArrowRight /></Link></Button></div>
        : <div className="course-bottom"><div><strong className={course.isFree ? 'text-success' : ''}>{course.isFree ? 'Free' : inr(course.price)}</strong></div>{course.rating != null && <span className="rating">★ {course.rating}</span>}</div>}</div></article>;
}
export const initials = (n: string) => n.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();

type NavItem = { to: string; label: string; icon: typeof BookOpen };
const nav: Record<Role, NavItem[]> = {
  STUDENT: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }, { to: '/student/my-learning', label: 'My Learning', icon: BookOpen }, { to: '/student/purchases', label: 'Purchases', icon: ShoppingBag }, { to: '/student/assessments', label: 'Assessments', icon: ClipboardList }, { to: '/student/certificates', label: 'Certificates', icon: Award }, { to: '/student/profile', label: 'Profile', icon: UserRound }],
  INSTRUCTOR: [{ to: '/instructor', label: 'Overview', icon: LayoutDashboard }, { to: '/instructor/courses', label: 'My Courses', icon: BookOpen }, { to: '/instructor/create', label: 'Create Course', icon: Plus }, { to: '/instructor/quizzes', label: 'Quizzes', icon: ClipboardList }, { to: '/instructor/assignments', label: 'Assignments', icon: Layers }, { to: '/instructor/submissions', label: 'Submissions', icon: Users }, { to: '/instructor/profile', label: 'Profile', icon: UserRound }],
  ADMIN: [{ to: '/admin', label: 'Overview', icon: LayoutDashboard }, { to: '/admin/roles', label: 'Role management', icon: ShieldCheck }, { to: '/admin/users', label: 'Users', icon: Users }, { to: '/admin/courses', label: 'Course moderation', icon: BookOpen }, { to: '/admin/payments', label: 'Payment reports', icon: CreditCard }, { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 }, { to: '/admin/profile', label: 'Profile', icon: UserRound }],
};

/** Client-side guard: hides UI for the wrong role. Real authorization is enforced by the API. */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    if (status === 'guest' || (user && !roles.includes(user.role))) done.current = true;
    if (status === 'guest') { const href = window.location.pathname + window.location.search; navigate({ to: '/login', search: href.startsWith('/login') ? {} : { redirect: href }, replace: true }); }
    else if (user && !roles.includes(user.role)) navigate({ to: '/restricted', replace: true });
  }, [status, user, roles, navigate]);
  if (status !== 'authenticated' || !user || !roles.includes(user.role)) return <main className="wide public-page" aria-busy="true" aria-label="Checking your access"><div className="h-9 w-64 bg-muted rounded-md animate-pulse mb-5" /><Loading /></main>;
  return <>{children}</>;
}

export function Workspace({ role, children }: { role: Role; children: ReactNode }) {
  return <RequireRole roles={[role]}><WorkspaceShell role={role}>{children}</WorkspaceShell></RequireRole>;
}
function WorkspaceShell({ role, children }: { role: Role; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const path = useRouterState({ select: s => s.location.pathname });
  return <div className="workspace"><aside className={`workspace-sidebar ${open ? 'sidebar-open' : ''}`}><Brand /><div className="workspace-label">{role === 'INSTRUCTOR' ? 'INSTRUCTOR WORKSPACE' : role === 'ADMIN' ? 'PLATFORM ADMIN' : 'LEARNING WORKSPACE'}</div>
    <nav>{nav[role].map(({ to, label, icon: Icon }) => <a key={to} href={to} onClick={e => { e.preventDefault(); setOpen(false); navigate({ to }); }} className={`side-link ${path === to || (to !== '/instructor' && to !== '/admin' && path.startsWith(to + '/')) ? 'active' : ''}`}><Icon size={19} />{label}</a>)}</nav>
    <div className="sidebar-bottom"><div className="sidebar-help"><CircleHelp size={22} /><strong>A little help goes a long way.</strong><a href="mailto:help@skillforge.example">Contact support <ArrowUpRight size={14} /></a></div><Link to="/courses" className="side-link"><Search size={18} />Explore courses</Link><button type="button" className="side-link w-full" onClick={async () => { await logout(); navigate({ to: '/login', replace: true }); }}><LogOut size={18} />Sign out</button></div></aside>
    <div className="workspace-main"><header className="workspace-topbar"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="workspace-menu" aria-label="Toggle sidebar" onClick={() => setOpen(!open)}><Menu /></Button><span className="topbar-breadcrumb">Workspace <ChevronRight size={14} /> {role === 'INSTRUCTOR' ? 'Instructor' : role === 'ADMIN' ? 'Admin' : 'My learning'}</span></div><div className="topbar-right"><Status tone="primary">{role.charAt(0) + role.slice(1).toLowerCase()}</Status>{user?.avatar ? <img src={user.avatar} alt="" className="avatar object-cover" /> : <span className="avatar" aria-label={user?.name}>{initials(user?.name ?? 'SF')}</span>}</div></header>
      <main className="workspace-content">{children}</main><div className="workspace-foot">© 2026 SkillForge <span>Your next chapter starts here.</span></div></div></div>;
}
export function Locked({ text }: { text: string }) { return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole size={13} />{text}</span>; }
export { Clock3 };
