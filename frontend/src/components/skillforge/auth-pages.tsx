import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight, LockKeyhole, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorText } from '@/lib/api/client';
import { useAuth } from '@/lib/api/auth';
import { homeFor } from '@/lib/api/models';
import { Header, Footer, ErrorBox, Notice } from './shared';

function AuthShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <><Header /><main className="wide public-page"><div className="form-shell mx-auto max-w-[480px]"><div className="eyebrow">SKILLFORGE ACCOUNT</div><h1 className="text-2xl mb-2">{title}</h1><p className="text-sm text-muted-foreground mb-6">{description}</p>{children}</div></main><Footer /></>;
}
export function LoginPage({ redirect }: { redirect?: string | undefined }) {
  const { login } = useAuth(); const navigate = useNavigate();
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr('');
    try { const u = await login(String(f.get('email')), String(f.get('password'))); const safe = redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : homeFor(u.role); navigate({ to: safe, replace: true }); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return <AuthShell title="Welcome back." description="Sign in to continue your learning journey.">{err && <ErrorBox message={err} />}<form onSubmit={submit} className="mt-4"><label className="field"><span>Email address</span><input name="email" type="email" autoComplete="email" required /></label><label className="field"><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label><Button type="submit" disabled={busy} className="w-full">{busy ? 'Signing in…' : 'Sign in'} <ArrowRight /></Button></form><div className="flex justify-between mt-5 text-sm"><Link to="/forgot-password" className="text-primary">Forgot password?</Link><Link to="/register" className="text-primary">Create an account</Link></div></AuthShell>;
}
export function RegisterPage() {
  const { refresh } = useAuth(); const navigate = useNavigate();
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setErr('');
    if (String(f.get('password')).length < 8) { setErr('Use at least 8 characters for your password.'); return; }
    const avatar = f.get('avatar'); if (avatar instanceof File && !avatar.size) f.delete('avatar');
    setBusy(true);
    try { await api('/auth/register', { body: f }); const u = await refresh(); navigate({ to: u ? homeFor(u.role) : '/login', replace: true }); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return <AuthShell title="Start your next chapter." description="Create a free student account. Paid courses are individual one-time purchases.">{err && <ErrorBox message={err} />}<form onSubmit={submit} className="mt-4"><label className="field"><span>Full name</span><input name="fullName" autoComplete="name" required /></label><label className="field"><span>Email address</span><input name="email" type="email" autoComplete="email" required /></label><label className="field"><span>Password</span><input name="password" type="password" autoComplete="new-password" minLength={8} required /></label><label className="field"><span>Profile photo (optional)</span><input name="avatar" type="file" accept="image/png,image/jpeg,image/webp" /></label><Button type="submit" disabled={busy} className="w-full">{busy ? 'Creating account…' : 'Create account'} <ArrowRight /></Button></form><p className="text-sm mt-5">Already learning with us? <Link to="/login" className="text-primary">Sign in</Link></p></AuthShell>;
}
export function ForgotPage() {
  const [done, setDone] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return <AuthShell title="Reset your password." description="We’ll email you a secure link to choose a new password.">{done ? <Notice tone="success">If an account exists for that email, a reset link is on its way.</Notice> : <>{err && <ErrorBox message={err} />}<form className="mt-4" onSubmit={async e => { e.preventDefault(); const email = String(new FormData(e.currentTarget).get('email')); setBusy(true); setErr(''); try { await api('/auth/reset', { body: { email } }); setDone(true); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }}><label className="field"><span>Email address</span><input name="email" type="email" required /></label><Button type="submit" disabled={busy} className="w-full">{busy ? 'Sending…' : 'Send reset link'}</Button></form></>}<p className="text-sm mt-5"><Link to="/login" className="text-primary">Back to sign in</Link></p></AuthShell>;
}
export function ResetPage({ token }: { token: string }) {
  const [done, setDone] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return <AuthShell title="Choose a new password." description="Use at least 8 characters.">{done ? <><Notice tone="success">Your password has been updated.</Notice><Button asChild className="mt-4"><Link to="/login">Sign in <ArrowRight /></Link></Button></> : <>{err && <ErrorBox message={err} />}<form className="mt-4" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); const password = String(f.get('password')); if (password !== f.get('confirm')) { setErr('Passwords don’t match.'); return; } setBusy(true); setErr(''); try { await api(`/auth/reset/${encodeURIComponent(token)}`, { body: { password } }); setDone(true); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }}><label className="field"><span>New password</span><input name="password" type="password" minLength={8} autoComplete="new-password" required /></label><label className="field"><span>Confirm password</span><input name="confirm" type="password" minLength={8} required /></label><Button type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Update password'}</Button></form></>}</AuthShell>;
}
export function RestrictedPage() {
  const { user } = useAuth();
  return <><Header /><main className="wide public-page"><div className="verification"><ShieldAlert size={58} /><h1 className="mt-5">Access restricted.</h1><p className="text-sm text-muted-foreground">This area isn’t available for your account{user ? ` (${user.role.toLowerCase()})` : ''}. If you think this is a mistake, contact your SkillForge administrator.</p><div className="flex gap-3 justify-center mt-6">{user ? <Button asChild><Link to={homeFor(user.role)}>Go to my workspace <ArrowRight /></Link></Button> : <Button asChild><Link to="/login"><LockKeyhole />Sign in</Link></Button>}<Button variant="outline" asChild><Link to="/courses">Explore courses</Link></Button></div></div></main><Footer /></>;
}
