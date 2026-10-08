import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, pick, pickList, ApiError, errorText } from './client';
import { useAuth } from './auth';
import { toCourse, type ApiCourse } from './models';

export type LearningItem = { course: ApiCourse; progress: number; lastLectureId?: string | undefined; lastLectureTitle?: string | undefined; completedCount: number; accessType: string };
export function toLearning(x: any): LearningItem {
  const c = x?.course && typeof x.course === 'object' ? x.course : x;
  const p = x?.progress && typeof x.progress === 'object' ? x.progress : x;
  const last = p?.lastWatchedLecture ?? p?.lastLecture ?? x?.lastWatchedLecture;
  return { course: toCourse(c), progress: Number(p?.completionPercent ?? p?.percentage ?? p?.progressPercentage ?? p?.completionPercentage ?? (typeof x?.progress === 'number' ? x.progress : 0)) || 0, lastLectureId: last ? (typeof last === 'string' ? last : String(last._id ?? last.id)) : undefined, lastLectureTitle: typeof last === 'object' ? last?.title : undefined, completedCount: Array.isArray(p?.completedLectures) ? p.completedLectures.length : Number(p?.completedLectures ?? 0) || 0, accessType: String(x?.accessType ?? x?.source ?? (c?.price ? 'PURCHASE' : 'FREE')) };
}
export function useCourses() { return useQuery({ queryKey: ['courses'], queryFn: async () => pickList(await api('/courses'), 'courses').map(toCourse) }); }
export function useCourse(id: string) { return useQuery({ queryKey: ['course', id], queryFn: async () => toCourse(pick(await api(`/courses/${id}`), 'course')) , retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 }); }
export function useMyLearning() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['me', 'learning'], enabled: user?.role === 'STUDENT', queryFn: async () => pickList(await api('/me/learning'), 'learning', 'courses', 'enrollments').map(toLearning) });
}
export function usePurchases() { const { user } = useAuth(); return useQuery({ queryKey: ['purchases'], enabled: user?.role === 'STUDENT', queryFn: async () => pickList(await api('/purchases'), 'purchases') }); }

declare global { interface Window { Razorpay?: any } }
function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise(res => { const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => res(true); s.onerror = () => res(false); document.body.appendChild(s); });
}
export type CheckoutState = { phase: 'idle' | 'creating' | 'awaiting' | 'verifying' | 'success' | 'owned' | 'cancelled' | 'failed'; message?: string | undefined };
const owned = (j: any) => Boolean(pick(j, 'alreadyPurchased') === true || pick(j, 'hasAccess') === true || pick(j, 'alreadyOwned') === true || String(pick(j, 'status') ?? '').toUpperCase() === 'VERIFIED' || (pick<any>(j, 'purchase')?.status && String(pick<any>(j, 'purchase').status).toUpperCase() === 'VERIFIED'));

/** Razorpay Test Mode checkout. Access is granted only after /payments/verify succeeds. */
export function useCheckout(course: ApiCourse | undefined, userInfo?: { name: string; email: string }) {
  const qc = useQueryClient();
  const [state, setState] = useState<CheckoutState>({ phase: 'idle' });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['me', 'learning'] }), qc.invalidateQueries({ queryKey: ['purchases'] }), qc.invalidateQueries({ queryKey: ['course'] })]);
  const start = async () => {
    if (!course) return;
    setState({ phase: 'creating' });
    let j: any;
    try { j = await api('/payments/orders', { body: { courseId: course.id } }); }
    catch (e) { if (e instanceof ApiError && e.status === 409) { await refresh(); setState({ phase: 'owned', message: e.message }); } else setState({ phase: 'failed', message: errorText(e) }); return; }
    if (owned(j)) { await refresh(); setState({ phase: 'owned', message: 'You already own this course. Happy learning!' }); return; }
    const order = pick<any>(j, 'order') ?? {}; const keyId = pick<string>(j, 'keyId', 'key');
    if (!order?.id || !keyId) { setState({ phase: 'failed', message: 'We couldn’t start checkout. Please try again.' }); return; }
    if (!(await loadRazorpay())) { setState({ phase: 'failed', message: 'The payment window couldn’t load. Check your connection or ad blocker.' }); return; }
    setState({ phase: 'awaiting' });
    const rzp = new window.Razorpay({
      key: keyId, order_id: order.id, amount: order.amount, currency: order.currency ?? 'INR', name: 'SkillForge', description: `${course.title} · One-time purchase`, prefill: userInfo, theme: { color: '#4f46e5' },
      handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        setState({ phase: 'verifying' });
        try { await api('/payments/verify', { body: { razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature } }); await refresh(); setState({ phase: 'success' }); }
        catch (e) { if (e instanceof ApiError && e.status === 409) { await refresh(); setState({ phase: 'owned', message: e.message }); } else setState({ phase: 'failed', message: `${errorText(e)} If you were charged, your purchase will appear once it is verified.` }); }
      },
      modal: { ondismiss: () => setState(s => (s.phase === 'awaiting' ? { phase: 'cancelled', message: 'Checkout was closed. No payment was taken.' } : s)) },
    });
    rzp.on?.('payment.failed', (r: any) => setState({ phase: 'failed', message: r?.error?.description ?? 'The payment didn’t go through. You can try again.' }));
    rzp.open();
  };
  return { state, start, reset: () => setState({ phase: 'idle' }) };
}
