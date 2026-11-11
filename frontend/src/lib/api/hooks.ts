import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, pick, pickList, ApiError } from './client';
import { useAuth } from './auth';
import { toCourse, toChatbotReply, toStudyPlanResponse, toCoursePracticeReply, toInstructorAiDraftReply, toLearningCoach, type ApiCourse, type AiProfileResponse, type AiProfileInput, type AiRecommendation, type AiGuidance, type AiChatInput, type AiAssistantReply, type ChatbotInput, type StudyPlanPeriod, type StudyPlanSession, type CoursePracticeInput, type CoursePracticeReply, type InstructorAiDraftKind, type InstructorAiDraftReply } from './models';
import { presentApiError, type ErrorPresentation } from '../errors/present';
import { isMaterialId, toInstructorMaterial, toStudentMaterial, toCourseTutorReply, validMaterialFile, type CourseTutorInput } from './models';

const materialsKey = (userId: string | undefined, courseId: string) => ['materials', userId, courseId] as const;
const canManageMaterials = (role: string | undefined) => role === 'INSTRUCTOR' || role === 'ADMIN';
function requireMaterialsAccess(allowed: boolean, courseId: string) {
  if (!allowed) throw new ApiError(403, '', undefined, { code: 'AUTH_ROLE_FORBIDDEN' });
  if (!isMaterialId(courseId)) throw new ApiError(400, '', undefined, { code: 'MATERIAL_INVALID_REQUEST' });
}
// Mutations and query caches retain only safe DTOs/errors, including failure responses.
async function materialRequest(path: string, options: Parameters<typeof api>[1] = {}) {
  try { return await api(path, options); }
  catch (error) { if (error instanceof ApiError) throw new ApiError(error.status, '', undefined, { code: error.code }); throw error; }
}
export function useInstructorMaterials(courseId: string) {
  const { user } = useAuth();
  return useQuery({ queryKey: [...materialsKey(user?.id, courseId), 'instructor'], enabled: canManageMaterials(user?.role) && isMaterialId(courseId), retry: false,
    queryFn: async ({ signal }) => pickList(await materialRequest(`/instructor/courses/${courseId}/materials`, { signal }), 'materials').map(toInstructorMaterial).filter(item => item !== null) });
}
export function useStudentMaterials(courseId: string) {
  const { user } = useAuth();
  return useQuery({ queryKey: [...materialsKey(user?.id, courseId), 'student'], enabled: user?.role === 'STUDENT' && isMaterialId(courseId), retry: false,
    queryFn: async ({ signal }) => pickList(await materialRequest(`/courses/${courseId}/materials`, { signal }), 'materials').map(item => toStudentMaterial(item, courseId)).filter(item => item !== null) });
}
export function useMaterialLectures(courseId: string) {
  const { user } = useAuth();
  return useQuery({ queryKey: [...materialsKey(user?.id, courseId), 'lectures'], enabled: Boolean(user) && isMaterialId(courseId), retry: false,
    queryFn: async ({ signal }) => {
      const course = pick(await materialRequest(`/courses/${courseId}`, { signal }), 'course');
      return (Array.isArray(course?.lectures) ? course.lectures : []).flatMap((item: any) => {
        const id = item?.id ?? item?._id;
        return isMaterialId(id) && typeof item?.title === 'string' ? [{ id, title: item.title as string }] : [];
      }) as { id: string; title: string }[];
    } });
}
type MaterialAction = { action: 'publish' | 'unpublish' | 'retry' | 'delete'; materialId: string };
export function useMaterialActions(courseId: string) {
  const { user } = useAuth(); const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: materialsKey(user?.id, courseId) });
  const upload = useMutation({ retry: false,
    mutationFn: async ({ file, title, lectureId }: { file: File; title: string; lectureId?: string | undefined }) => {
      requireMaterialsAccess(canManageMaterials(user?.role), courseId);
      if (validMaterialFile(file) || !title.trim() || title.trim().length > 120 || (lectureId && !isMaterialId(lectureId))) throw new ApiError(400, '', undefined, { code: 'MATERIAL_INVALID_REQUEST' });
      const body = new FormData(); body.append('file', file); body.append('title', title.trim()); if (lectureId) body.append('lectureId', lectureId);
      return toInstructorMaterial(pick(await materialRequest(`/instructor/courses/${courseId}/materials`, { method: 'POST', body }), 'material'));
    }, onSettled: refresh });
  const update = useMutation({ retry: false,
    mutationFn: async ({ action, materialId }: MaterialAction) => {
      requireMaterialsAccess(canManageMaterials(user?.role), courseId);
      if (!isMaterialId(materialId)) throw new ApiError(400, '', undefined, { code: 'MATERIAL_INVALID_REQUEST' });
      const path = `/instructor/courses/${courseId}/materials/${materialId}`;
      if (action === 'delete') { await materialRequest(path, { method: 'DELETE' }); return null; }
      const result = action === 'retry' ? await materialRequest(`${path}/retry`, { method: 'POST' })
        : await materialRequest(`${path}/status`, { method: 'PATCH', body: { status: action === 'publish' ? 'PUBLISHED' : 'READY' } });
      return toInstructorMaterial(pick(result, 'material'));
    }, onSettled: refresh });
  return { upload, update };
}
export function useCourseTutor() {
  const { user } = useAuth();
  return useMutation({ retry: false, gcTime: 0,
    mutationFn: async ({ courseId, lectureId, question, plainLanguage = false }: CourseTutorInput) => {
      requireMaterialsAccess(user?.role === 'STUDENT', courseId);
      if (!question.trim() || question.length > 2000 || (lectureId && !isMaterialId(lectureId))
        || typeof plainLanguage !== 'boolean') throw new ApiError(400, '', undefined, { code: 'AI_TUTOR_INVALID' });
      return toCourseTutorReply(pick(await materialRequest('/ai/course-tutor', { method: 'POST', body: {
        courseId, ...(lectureId ? { lectureId } : {}), question: question.trim(),
        ...(plainLanguage ? { plainLanguage: true } : {})
      } }), 'tutor'));
    } });
}
export function useCoursePractice() {
  const { user } = useAuth();
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async ({ courseId, lectureId, topic, plainLanguage = false }: CoursePracticeInput): Promise<CoursePracticeReply> => {
      requireMaterialsAccess(user?.role === 'STUDENT', courseId);
      if (!topic.trim() || topic.length > 2000 || (lectureId && !isMaterialId(lectureId))
        || typeof plainLanguage !== 'boolean') {
        throw new ApiError(400, '', undefined, { code: 'AI_PRACTICE_INVALID' });
      }
      const response = await materialRequest('/ai/course-practice', {
        method: 'POST',
        body: { courseId, ...(lectureId ? { lectureId } : {}), topic: topic.trim(),
          ...(plainLanguage ? { plainLanguage: true } : {}) },
      });
      if (response?.success !== true) throw new ApiError(502, '', undefined, { code: 'AI_PRACTICE_UNAVAILABLE' });
      return toCoursePracticeReply(pick(response, 'practice'));
    },
  });
}
export function useInstructorAiDraft() {
  const { user } = useAuth();
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async ({ courseId, kind, focus }: { courseId: string; kind: InstructorAiDraftKind; focus: string }): Promise<InstructorAiDraftReply> => {
      if (user?.role !== 'INSTRUCTOR') throw new ApiError(403, '', undefined, { code: 'AUTH_ROLE_FORBIDDEN' });
      if (!isMaterialId(courseId) || !['OUTLINE', 'PRACTICE_PROMPTS', 'ASSIGNMENT_RUBRIC'].includes(kind)
        || !focus.trim() || focus.trim().length > 300) throw new ApiError(400, '', undefined, { code: 'AI_DRAFT_INVALID' });
      const result = await materialRequest(`/instructor/courses/${courseId}/ai-drafts`, {
        method: 'POST', body: { kind, focus: focus.trim() }
      });
      if (result?.success !== true) throw new ApiError(502, '', undefined, { code: 'AI_DRAFT_UNAVAILABLE' });
      const draft = toInstructorAiDraftReply({ ...result.draft, sourceMode: result.sourceMode });
      if (!draft) throw new ApiError(502, '', undefined, { code: 'AI_DRAFT_UNAVAILABLE' });
      return draft;
    }
  });
}

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

export function useAiProfile() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['ai', user?.id, 'profile'], enabled: user?.role === 'STUDENT', retry: false,
    queryFn: ({ signal }) => api<AiProfileResponse>('/ai/profile', { signal }) });
}
export function useSaveAiProfile() {
  const { user } = useAuth(); const qc = useQueryClient();
  return useMutation({ retry: false,
    mutationFn: (input: AiProfileInput) => api<AiProfileResponse>('/ai/profile', { method: 'PUT', body: {
      ...(input.careerGoal !== undefined ? { careerGoal: input.careerGoal } : {}),
      ...(input.interests !== undefined ? { interests: input.interests } : {}),
      ...(input.selfReportedSkills !== undefined ? { selfReportedSkills: input.selfReportedSkills } : {}),
      ...(input.experienceLevel !== undefined ? { experienceLevel: input.experienceLevel } : {}),
      ...(input.weeklyAvailabilityHours !== undefined ? { weeklyAvailabilityHours: input.weeklyAvailabilityHours } : {}),
    } }),
    onSuccess: async data => {
      qc.setQueryData(['ai', user?.id, 'profile'], data);
      await qc.invalidateQueries({ queryKey: ['ai', user?.id, 'recommendations'] });
    },
  });
}
export function useAiRecommendations(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['ai', user?.id, 'recommendations'], enabled: enabled && user?.role === 'STUDENT', retry: false,
    queryFn: async ({ signal }) => (await api<{ success: true; recommendations: AiRecommendation[] }>('/ai/recommendations', { signal })).recommendations });
}
export function useAiGuidance(enabled = true) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['ai', user?.id, 'guidance'], enabled: enabled && user?.role === 'STUDENT', retry: false,
    queryFn: async ({ signal }) => (await api<{ success: true; guidance: AiGuidance }>('/ai/guidance', { signal })).guidance });
}
export function useLearningCoach(enabled = true) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['ai', user?.id, 'coach'], enabled: enabled && user?.role === 'STUDENT', retry: false,
    queryFn: async ({ signal }) => {
      const coach = toLearningCoach(pick(await materialRequest('/ai/coach', { signal }), 'coach'));
      if (!coach) throw new ApiError(502, '', undefined, { code: 'AI_UNAVAILABLE' });
      return coach;
    } });
}
const studyPlanKey = (userId: string | undefined, period: StudyPlanPeriod | null) =>
  ['ai', userId, 'study-plan', period?.startDate, period?.timeZone] as const;
function studyPlanQuery(period: StudyPlanPeriod) {
  const query = new URLSearchParams({ startDate: period.startDate, timeZone: period.timeZone });
  return `/ai/study-plan?${query.toString()}`;
}
export function useStudyPlan(period: StudyPlanPeriod | null, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: studyPlanKey(user?.id, period),
    enabled: enabled && user?.role === 'STUDENT' && Boolean(period),
    retry: false,
    queryFn: async ({ signal }) => {
      if (!period) throw new ApiError(400, '', undefined, { code: 'AI_STUDY_PLAN_INVALID' });
      const response = toStudyPlanResponse(await materialRequest(studyPlanQuery(period), { signal }));
      if (!response.success || (!response.plan && !response.preview)) throw new ApiError(502, '', undefined, { code: 'AI_STUDY_PLAN_UNAVAILABLE' });
      return response;
    },
  });
}
export function usePreviewStudyPlan() {
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (period: StudyPlanPeriod) => {
      const response = toStudyPlanResponse(await materialRequest('/ai/study-plan/preview', { method: 'POST', body: period }));
      if (!response.success || !response.preview) throw new ApiError(502, '', undefined, { code: 'AI_STUDY_PLAN_UNAVAILABLE' });
      return response.preview;
    },
  });
}
export function useSaveStudyPlan(period: StudyPlanPeriod | null) {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (sessions: StudyPlanSession[]) => {
      if (!period) throw new ApiError(400, '', undefined, { code: 'AI_STUDY_PLAN_INVALID' });
      const response = toStudyPlanResponse(await materialRequest('/ai/study-plan', {
        method: 'PUT',
        body: { ...period, sessions: sessions.map(({ id, day, minutes }) => ({ id, day, minutes })) },
      }));
      if (!response.success || !response.plan) throw new ApiError(502, '', undefined, { code: 'AI_STUDY_PLAN_UNAVAILABLE' });
      return response.plan;
    },
    onSuccess: async () => { if (period) await qc.invalidateQueries({ queryKey: studyPlanKey(user?.id, period) }); },
  });
}
export function useDeleteStudyPlan(period: StudyPlanPeriod | null) {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async () => {
      if (!period) throw new ApiError(400, '', undefined, { code: 'AI_STUDY_PLAN_INVALID' });
      const query = new URLSearchParams({ startDate: period.startDate, timeZone: period.timeZone });
      const response = await materialRequest(`/ai/study-plan?${query.toString()}`, { method: 'DELETE' });
      if (response?.success !== true) throw new ApiError(502, '', undefined, { code: 'AI_STUDY_PLAN_UNAVAILABLE' });
      return response;
    },
    onSuccess: async () => { if (period) await qc.invalidateQueries({ queryKey: studyPlanKey(user?.id, period) }); },
  });
}
export function useSiteChatbot() {
  return useMutation({ retry: false, gcTime: 0,
    mutationFn: async ({ message, courseId, lectureId, history = [], plainLanguage = false }: ChatbotInput) => {
      if (!message.trim() || message.length > 2000 || (courseId && !isMaterialId(courseId))
        || (lectureId && (!courseId || !isMaterialId(lectureId)))
        || typeof plainLanguage !== 'boolean'
        || history.length > 8 || history.some((turn) => !turn || !['user', 'assistant'].includes(turn.role)
          || !turn.message.trim() || turn.message.length > 1200)) {
        throw new ApiError(400, '', undefined, { code: 'AI_CHAT_INVALID' });
      }
      const result = await materialRequest('/ai/chatbot', {
        method: 'POST',
        body: { message: message.trim(), ...(courseId ? { courseId } : {}),
          ...(lectureId ? { lectureId } : {}), ...(history.length ? { history } : {}),
          ...(plainLanguage ? { plainLanguage: true } : {}) },
      });
      const reply = toChatbotReply(pick(result, 'chatbot'));
      if (!reply.message) throw new ApiError(502, '', undefined, { code: 'AI_UNAVAILABLE' });
      return reply;
    } });
}
export function useAiChat() {
  return useMutation({ retry: false,
    mutationFn: async ({ message, courseId }: AiChatInput) => (await api<{ success: true; assistant: AiAssistantReply }>('/ai/chat', {
      method: 'POST', body: { message, ...(courseId ? { courseId } : {}) },
    })).assistant });
}

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
