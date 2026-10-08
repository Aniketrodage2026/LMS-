// Tolerant normalizers so UI code works with the backend's document shapes.
export type Role = 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';
export type User = { id: string; name: string; email: string; role: Role; avatar?: string | undefined; bio?: string | undefined };
export type Lecture = { id: string; title: string; description?: string | undefined; duration?: number | undefined; isPreview: boolean; order: number; videoUrl?: string | undefined; section?: string | undefined };
export type ApiCourse = { id: string; title: string; description: string; category: string; level: string; price: number; isFree: boolean; thumbnail?: string | undefined; instructorName: string; instructorId?: string | undefined; lectures: Lecture[]; lectureCount: number; rating?: number | undefined; status?: string | undefined; previewLectureId?: string | undefined; hasAccess?: boolean | undefined; isPurchased?: boolean | undefined; isEnrolled?: boolean | undefined; requirements: string[]; outcomes: string[] };
export type Submission = { writtenAnswer: string; fileUrl?: string | undefined; [key: string]: unknown };
export type ProgressLecture = { id: string; title: string; watchedSeconds: number; watchedPercent: number; durationSeconds: number; completed: boolean };
export type LearningProgress = { completionPercent: number; totalLectures: number; completedLectures: number; lectures: ProgressLecture[] };

const id = (o: any) => String(o?._id ?? o?.id ?? '');
const url = (v: any) => (typeof v === 'string' ? v : v?.secure_url ?? v?.secureUrl ?? v?.url ?? undefined);
export const roleOf = (r: any): Role => { const s = String(r ?? 'STUDENT').toUpperCase(); return s === 'ADMIN' || s === 'INSTRUCTOR' ? s : 'STUDENT'; };
export function toUser(u: any): User | null {
  if (!u || typeof u !== 'object') return null;
  return { id: id(u), name: u.name ?? u.fullName ?? u.username ?? 'Learner', email: u.email ?? '', role: roleOf(u.role), avatar: url(u.avatar), bio: u.bio };
}
export function toLecture(l: any, i = 0): Lecture {
  return { id: id(l), title: l?.title ?? `Lesson ${i + 1}`, description: l?.description, duration: Number(l?.durationSeconds ?? l?.duration ?? 0) || undefined, isPreview: Boolean(l?.isPreview ?? l?.preview), order: Number(l?.order ?? i), videoUrl: url(l?.secureUrl ?? l?.lecture ?? l?.video ?? l?.videoUrl), section: l?.section };
}
export function toCourse(c: any): ApiCourse {
  const price = Number(c?.price ?? 0) || 0;
  const lectures = (Array.isArray(c?.lectures) ? c.lectures : []).map(toLecture);
  const ins = c?.instructor ?? c?.creator ?? c?.createdBy;
  return {
    id: id(c), title: c?.title ?? 'Untitled course', description: c?.description ?? '', category: c?.category ?? 'General', level: c?.level ?? 'All levels',
    price, isFree: c?.isFree ?? (c?.accessType ? String(c.accessType).toUpperCase() === 'FREE' : price === 0),
    thumbnail: url(c?.thumbnail), instructorName: typeof ins === 'string' ? 'SkillForge instructor' : ins?.fullName ?? ins?.name ?? 'SkillForge instructor', instructorId: typeof ins === 'string' ? ins : ins ? id(ins) : undefined,
    lectures, lectureCount: Number(c?.numberOflectures ?? c?.numberOfLectures ?? c?.lectureCount ?? lectures.length) || lectures.length, rating: c?.rating != null ? Number(c.rating) : undefined,
    status: c?.status ?? (c?.isPublished === false ? 'DRAFT' : c?.isPublished ? 'PUBLISHED' : undefined),
    previewLectureId: c?.previewLecture ? (typeof c.previewLecture === 'string' ? c.previewLecture : id(c.previewLecture)) : lectures.find((l: Lecture) => l.isPreview)?.id,
    hasAccess: c?.hasAccess, isPurchased: c?.isPurchased, isEnrolled: c?.isEnrolled,
    requirements: Array.isArray(c?.requirements) ? c.requirements : [], outcomes: Array.isArray(c?.outcomes ?? c?.whatYouWillLearn) ? (c.outcomes ?? c.whatYouWillLearn) : [],
  };
}
export const toPaise = (rupees: number) => Math.round((Number(rupees) || 0) * 100);
/** Convert a decimal INR input to integral paise without floating-point rounding. */
export function toPaiseExact(value: string) {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
/** Render stored paise for a number input without losing sub-rupee precision. */
export function paiseToInrInput(paise: number) {
  const amount = Math.max(0, Math.trunc(Number(paise) || 0));
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}
export const inr = (paise: number) => (paise ? `₹${(Number(paise) / 100).toLocaleString('en-IN')}` : 'Free');
export function toSubmission(s: any): Submission {
  return { ...(s && typeof s === 'object' ? s : {}), writtenAnswer: String(s?.writtenAnswer ?? s?.answer ?? ''), fileUrl: url(s?.file) ?? s?.fileUrl };
}
export function toLearningProgress(p: any): LearningProgress {
  const lectures = (Array.isArray(p?.lectures) ? p.lectures : []).map((lecture: any): ProgressLecture => ({
    id: id(lecture), title: String(lecture?.title ?? 'Untitled lesson'), watchedSeconds: Number(lecture?.watchedSeconds ?? 0) || 0,
    watchedPercent: Number(lecture?.watchedPercent ?? 0) || 0, durationSeconds: Number(lecture?.durationSeconds ?? 0) || 0, completed: Boolean(lecture?.completed),
  }));
  const completedLectures = Number(p?.completedLectures);
  return {
    completionPercent: Number(p?.completionPercent ?? 0) || 0,
    totalLectures: Number(p?.totalLectures) || lectures.length,
    completedLectures: Number.isFinite(completedLectures) ? completedLectures : lectures.filter(lecture => lecture.completed).length,
    lectures,
  };
}
export function progressPayload(watchedSeconds: number, durationSeconds: number, mediaDuration?: number) {
  const serverDuration = Number(durationSeconds);
  const browserDuration = Number(mediaDuration);
  const duration = Number.isFinite(serverDuration) && serverDuration > 0
    ? serverDuration
    : Number.isFinite(browserDuration) && browserDuration > 0 ? browserDuration : 0;
  const watched = Number(watchedSeconds);
  return { watchedSeconds: Math.min(duration, Number.isFinite(watched) ? Math.max(0, Math.floor(watched)) : 0), durationSeconds: duration };
}
export const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const homeFor = (role: Role) => (role === 'ADMIN' ? '/admin' : role === 'INSTRUCTOR' ? '/instructor' : '/dashboard');

export type SubmissionState = 'SUBMITTED' | 'PENDING_REVIEW' | 'GRADED' | 'RESUBMISSION_REQUESTED';
export function submissionState(s: any): SubmissionState {
  const v = String(s?.status ?? 'SUBMITTED').toUpperCase().replace(/[\s-]/g, '_');
  if (v.includes('RESUBMI')) return 'RESUBMISSION_REQUESTED';
  if (v.includes('GRADE') || v === 'REVIEWED') return 'GRADED';
  if (v.includes('PENDING')) return 'PENDING_REVIEW';
  return 'SUBMITTED';
}
/** A student may submit unless their latest submission was graded (final) or is still awaiting review. */
export function canSubmit(latest: any | undefined) {
  if (!latest) return true;
  const s = submissionState(latest);
  return s === 'RESUBMISSION_REQUESTED';
}
/** Never let a delayed response move the saved watch position backwards. */
export const monotonic = (current: number, incoming: number) => Math.max(current || 0, incoming || 0);
export const MAX_UPLOAD_MB = 25;
export const ALLOWED_SUBMISSION_TYPES = ['.pdf', '.docx', '.zip', '.png', '.jpg', '.jpeg'];
export function validSubmissionFile(f: { name: string; size: number }) {
  const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
  if (!ALLOWED_SUBMISSION_TYPES.includes(ext)) return 'Allowed file types: PDF, DOCX, ZIP, PNG, JPG/JPEG.';
  if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Files must be ${MAX_UPLOAD_MB} MB or smaller.`;
  return null;
}
