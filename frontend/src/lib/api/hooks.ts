import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, pick, pickList, ApiError } from './client';
import { useAuth } from './auth';
import { toCourse, type ApiCourse } from './models';
import { presentApiError, type ErrorPresentation } from '../errors/present';

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
export type CheckoutState = { phase: 'idle' | 'creating' | 'awaiting' | 'verifying' | 'pending' | 'success' | 'owned' | 'cancelled' | 'failed'; message?: string | undefined; guidance?: ErrorPresentation | undefined };
type PaymentCallback = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
const owned = (j: any) => Boolean(pick(j, 'alreadyPurchased') === true || pick(j, 'hasAccess') === true || pick(j, 'alreadyOwned') === true || pick<any>(j, 'access')?.granted === true || String(pick(j, 'status') ?? '').toUpperCase() === 'VERIFIED' || (pick<any>(j, 'purchase')?.status && String(pick<any>(j, 'purchase').status).toUpperCase() === 'VERIFIED'));

/** Razorpay Test Mode checkout. Access is granted only after /payments/verify succeeds. */
export function useCheckout(course: ApiCourse | undefined, userInfo?: { name: string; email: string }) {
  const qc = useQueryClient();
  const [state, setState] = useState<CheckoutState>({ phase: 'idle' });
  const phase = useRef<CheckoutState['phase']>('idle');
  const callback = useRef<PaymentCallback | undefined>(undefined);
  const currentCourse = useRef(course?.id);
  const attemptVersion = useRef(0);
  const paymentWindowVersion = useRef(0);
  useEffect(() => {
    ++attemptVersion.current;
    ++paymentWindowVersion.current;
    currentCourse.current = course?.id;
    phase.current = 'idle';
    callback.current = undefined;
    setState({ phase: 'idle' });
    return () => { ++attemptVersion.current; ++paymentWindowVersion.current; currentCourse.current = undefined; };
  }, [course?.id]);
  const active = () => currentCourse.current === course?.id;
  const update = (next: CheckoutState) => { if (!active()) return; phase.current = next.phase; setState(next); };
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['me', 'learning'] }), qc.invalidateQueries({ queryKey: ['purchases'] }), qc.invalidateQueries({ queryKey: ['course'] })]);
  const guidanceFor = (error: unknown) => presentApiError(error, { courseId: course?.id, returnTo: course ? `/courses/${course.id}` : undefined });
  const coded = (code: string) => new ApiError(400, '', undefined, { code });
  const recover = (error: unknown, verification = false) => {
    const code = error instanceof ApiError ? error.code : undefined;
    const effectiveError = verification && (!code || code === 'NETWORK_ERROR' || code === 'SYSTEM_UNEXPECTED') ? coded('PAYMENT_VERIFICATION_UNAVAILABLE')
      : !verification && code === 'PAYMENT_VERIFICATION_UNAVAILABLE' ? coded('PAYMENT_ORDER_UNAVAILABLE') : error;
    const guidance = guidanceFor(effectiveError);
    const nextPhase = code === 'PAYMENT_ALREADY_OWNED' ? 'owned' : verification || code === 'PAYMENT_ORDER_PENDING' || code === 'PAYMENT_VERIFICATION_PENDING' || !guidance.retryable ? 'pending' : 'failed';
    update({ phase: nextPhase, message: guidance.message, guidance });
  };
  const verify = async (payload: PaymentCallback) => {
    if (active() && (phase.current === 'verifying' || phase.current === 'success')) return;
    // A callback owns checkout from now on. Pending order/script continuations
    // from a cancelled window's recovery must never open another payment window.
    const version = active() ? ++attemptVersion.current : undefined;
    const currentVerification = () => version !== undefined && active() && attemptVersion.current === version;
    if (active()) callback.current = payload;
    update({ phase: 'verifying' });
    try {
      await api('/payments/verify', { body: payload });
      await refresh();
      if (currentVerification()) {
        callback.current = undefined;
        update({ phase: 'success' });
      }
    } catch (error) { if (currentVerification()) recover(error, true); }
  };
  const start = async () => {
    if (!course || !active() || !['idle', 'failed', 'cancelled'].includes(phase.current)) return;
    const version = ++attemptVersion.current;
    const currentAttempt = () => active() && attemptVersion.current === version && !callback.current;
    const stillStarting = () => currentAttempt() && phase.current === 'creating';
    update({ phase: 'creating' });
    let j: any;
    try { j = await api('/payments/orders', { body: { courseId: course.id } }); }
    catch (error) {
      if (stillStarting()) recover(error instanceof ApiError && error.code && error.code !== 'NETWORK_ERROR' ? error : coded('PAYMENT_ORDER_UNAVAILABLE'));
      return;
    }
    if (!stillStarting()) return;
    const code = j?.error?.code ?? j?.code;
    if (code === 'PAYMENT_ALREADY_OWNED' || owned(j)) {
      await refresh();
      if (!stillStarting()) return;
      const guidance = guidanceFor(coded('PAYMENT_ALREADY_OWNED'));
      update({ phase: 'owned', message: guidance.message, guidance });
      return;
    }
    if (code === 'PAYMENT_ORDER_PENDING' || code === 'PAYMENT_VERIFICATION_PENDING' || j?.success === false) {
      recover(coded(code ?? 'PAYMENT_ORDER_UNAVAILABLE'));
      return;
    }
    const order = pick<any>(j, 'order') ?? {}; const keyId = pick<string>(j, 'keyId', 'key');
    if (!order?.id || !keyId) { recover(coded('PAYMENT_ORDER_UNAVAILABLE')); return; }
    try {
      const loaded = await loadRazorpay();
      if (!stillStarting()) return;
      if (!loaded) { recover(coded('PAYMENT_CHECKOUT_UNAVAILABLE')); return; }
      update({ phase: 'awaiting' });
      // A dismissed window still owns its callback during same-lifecycle
      // recovery, until a new window replaces it or the course lifecycle ends.
      const windowVersion = ++paymentWindowVersion.current;
      const currentWindow = () => active() && paymentWindowVersion.current === windowVersion;
      const rzp = new window.Razorpay({
        key: keyId, order_id: order.id, amount: order.amount, currency: order.currency ?? 'INR', name: 'SkillForge', description: `${course.title} · One-time purchase`, prefill: userInfo, theme: { color: '#4f46e5' },
        handler: (r: PaymentCallback) => {
          if (!currentWindow()) return;
          return verify({ razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature });
        },
        modal: { ondismiss: () => {
          if (currentAttempt() && phase.current === 'awaiting') {
            const guidance = guidanceFor(coded('PAYMENT_ORDER_REUSABLE'));
            update({ phase: 'cancelled', message: guidance.message, guidance });
          }
        } },
      });
      rzp.on?.('payment.failed', () => { if (currentAttempt() && phase.current === 'awaiting') recover(coded('PAYMENT_CHECKOUT_UNAVAILABLE')); });
      if (currentAttempt() && phase.current === 'awaiting') rzp.open();
    } catch {
      if (currentAttempt() && (phase.current === 'creating' || phase.current === 'awaiting')) recover(coded('PAYMENT_CHECKOUT_UNAVAILABLE'));
    }
  };
  return { state, start, retryVerification: () => callback.current ? verify(callback.current) : Promise.resolve(), reset: () => { if (phase.current === 'failed' || phase.current === 'cancelled') update({ phase: 'idle' }); } };
}
