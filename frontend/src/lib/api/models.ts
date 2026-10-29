// Tolerant normalizers so UI code works with the backend's document shapes.
export type Role = 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';
export type User = { id: string; name: string; email: string; role: Role; avatar?: string | undefined; bio?: string | undefined };
export type AdminUser = { id: string; name: string; email: string; avatar: string | null; role: Role; createdAt: string };
export type AdminCourseInstructor = { id: string; name: string; email: string; avatar: string | null };
export type AdminCourse = {
  id: string; title: string; description: string; thumbnail: string | null; instructor: AdminCourseInstructor | null;
  accessType: 'FREE' | 'PAID'; price: number; currency: 'INR'; status: 'PUBLISHED' | 'UNPUBLISHED';
  lectureCount: number; createdAt: string; updatedAt: string;
};
export type AdminPurchase = {
  id: string; student: { id: string; name: string; email: string } | null; course: { id: string; title: string } | null;
  amount: number; currency: 'INR'; verifiedAt: string;
};
export type AdminAuditEntry = {
  id: string; actor: string; action: string; target: { type: 'USER' | 'COURSE' | 'LECTURE' | 'QUIZ' | 'ASSIGNMENT' | 'SUBMISSION' | 'PURCHASE' | 'CERTIFICATE'; id: string };
  summary: Record<string, string>; createdAt: string;
};
export type AdminOverview = {
  success: true;
  metrics: {
    users: { total: number; students: number; instructors: number; admins: number };
    courses: { total: number; published: number }; activeEnrollments: number;
    purchases: { verifiedCount: number; verifiedRevenuePaise: number; currency: 'INR' };
    learning: { completedLectures: number; totalLectureSlots: number; completionPercent: number };
  };
  recentActivity: AdminAuditEntry[];
};
export type AdminUsersPage = { success: true; users: AdminUser[]; nextCursor: string | null };
export type AdminCoursesPage = { success: true; courses: AdminCourse[]; nextCursor: string | null };
export type AdminPurchasesPage = { success: true; purchases: AdminPurchase[]; nextCursor: string | null };
export type AdminAuditLogsPage = { success: true; entries: AdminAuditEntry[]; nextCursor: string | null };
export type AdminCourseStatusResponse = { success: true; course: AdminCourse };
export type Lecture = { id: string; title: string; description?: string | undefined; duration?: number | undefined; isPreview: boolean; order: number; videoUrl?: string | undefined; section?: string | undefined };
export type ApiCourse = { id: string; title: string; description: string; category: string; level: string; price: number; isFree: boolean; thumbnail?: string | undefined; instructorName: string; instructorId?: string | undefined; lectures: Lecture[]; lectureCount: number; rating?: number | undefined; status?: string | undefined; previewLectureId?: string | undefined; hasAccess?: boolean | undefined; isPurchased?: boolean | undefined; isEnrolled?: boolean | undefined; requirements: string[]; outcomes: string[] };
export type Submission = { writtenAnswer: string; fileDownloadEndpoint?: string | undefined; [key: string]: unknown };
export type ProgressLecture = { id: string; title: string; watchedSeconds: number; watchedPercent: number; durationSeconds: number; completed: boolean };
export type LearningProgress = { completionPercent: number; totalLectures: number; completedLectures: number; lectures: ProgressLecture[] };

// Safe AI DTOs are already projected by the server; preserve its ranking and facts.
export type AiExperienceLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
export type AiLearningProfile = { careerGoal: string; interests: string[]; selfReportedSkills: string[]; experienceLevel?: AiExperienceLevel | undefined; weeklyAvailabilityHours?: number | undefined };
export type AiProfileField = 'careerGoal' | 'interests' | 'experienceLevel' | 'weeklyAvailabilityHours';
export type AiProfileInput = Partial<AiLearningProfile>;
export type AiProfileResponse = { success: true; profile: AiLearningProfile | null; missingFields: AiProfileField[] };
export type AiCourseCard = { id: string; title: string; description: string; category: string; accessType: 'FREE' | 'PAID'; price: number; currency: 'INR'; thumbnailUrl: string | null; level: AiExperienceLevel | null; skills: string[] };
export type AiRecommendation = { course: AiCourseCard; score: number; signals: { interestCategoryMatch: number; goalKeywordMatch: number; skillMatch: number; levelFit: number; prerequisiteFit: number }; unmetPrerequisites: string[] };
export type AiActiveCourse = {
  course: { id: string; title: string; category: string };
  progress: { totalLectures: number; completedLectures: number; completionPercent: number };
  nextLecture: { id: string; title: string } | null;
  assessments: {
    totalQuizzes: number; totalAssignments: number;
    quizzes: { id: string; title: string; passMark: number; bestPercentage: number | null; passed: boolean }[];
    assignments: { id: string; title: string; dueDate: string | null; maxMarks: number; status: 'NOT_SUBMITTED' | 'SUBMITTED' | 'PENDING_REVIEW' | 'GRADED' | 'RESUBMISSION_REQUESTED'; marks: number | null }[];
  };
  certificate: { certificateNumber: string; issuedAt: string } | null;
  certificateEligibility?: {
    eligible: boolean; totalLectures: number; completedLectures: number; lecturePercent: number;
    requiredQuizzes: number; passedQuizzes: number; requiredAssignments: number; gradedAssignments: number; assessmentAverage: number;
    lectureRequirementMet: boolean; quizzesRequirementMet: boolean; assignmentsRequirementMet: boolean; assessmentRequirementMet: boolean;
  };
};
export type AiGuidance = { activeCourses: AiActiveCourse[] };
export type AiGrounding = 'PROFILE' | 'CATALOG' | 'PROGRESS' | 'COURSE_METADATA';
export type AiAssistantReply = { message: string; grounding: AiGrounding; recommendations?: AiRecommendation[] | undefined; guidance?: AiGuidance | undefined };
export type AiChatInput = { message: string; courseId?: string | undefined };

export type MaterialStatus = 'PROCESSING' | 'READY' | 'PUBLISHED' | 'FAILED';
export const materialFailureMessages: Record<string, string> = {
  INVALID_PDF: 'Choose a valid PDF file with selectable text.',
  PDF_TOO_LARGE: 'Choose a PDF that is 10 MB or smaller.',
  TOO_MANY_PAGES: 'Reduce the PDF to 100 pages or fewer and upload it again.',
  ENCRYPTED_PDF: 'Remove password protection from the PDF and upload it again.',
  NO_READABLE_TEXT: 'Choose a PDF with selectable text. Scanned images cannot be read yet.',
  EXTRACTION_FAILED: 'We could not read this PDF. Export a new PDF with selectable text and upload it again.',
  EMBEDDING_FAILED: 'We could not prepare this material. Refresh the material list, then retry the failed material shortly.',
  STORAGE_FAILED: 'We could not finish saving or removing this material. Refresh the material list before trying again.',
  PROCESSING_FAILED: 'We could not prepare this material. Refresh the material list, then retry the failed material shortly.',
};
export type InstructorMaterial = {
  id: string; courseId: string; lectureId: string | null; title: string; originalFilename: string; size: number;
  status: MaterialStatus; pageCount: number | null; chunkCount: number; failureCode: string | null;
  createdAt: string; updatedAt: string;
};
export type StudentMaterial = { id: string; title: string; lectureId: string | null; pageCount: number; downloadEndpoint: string };
export type TutorCitation = { materialId: string; title: string; pageStart: number; pageEnd: number };
export type CourseTutorOutcome = 'ANSWERED' | 'NO_RELEVANT_SOURCE' | 'RAG_UNAVAILABLE' | 'RAG_LIMIT_REACHED';
export type CourseTutorReply = { answer: string; citations: TutorCitation[]; outcome: CourseTutorOutcome };
export type CourseTutorInput = { courseId: string; lectureId?: string | undefined; question: string };
export const isMaterialId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const materialRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const materialText = (value: unknown, limit = 200): string => typeof value === 'string' ? value.slice(0, limit) : '';
const materialCount = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const materialLecture = (value: unknown) => isMaterialId(value) ? value : null;

/** Project allowlisted DTO fields only; never spread storage, source text, or provider data into query state. */
export function toInstructorMaterial(value: unknown): InstructorMaterial | null {
  const raw = materialRecord(value);
  if (!isMaterialId(raw['id']) || !isMaterialId(raw['courseId']) || !['PROCESSING', 'READY', 'PUBLISHED', 'FAILED'].includes(String(raw['status']))) return null;
  return { id: raw['id'], courseId: raw['courseId'], lectureId: materialLecture(raw['lectureId']), title: materialText(raw['title'], 120),
    originalFilename: materialText(raw['originalFilename']), size: materialCount(raw['size']), status: raw['status'] as MaterialStatus,
    pageCount: raw['pageCount'] === null ? null : materialCount(raw['pageCount']), chunkCount: materialCount(raw['chunkCount']),
    failureCode: typeof raw['failureCode'] === 'string' && Object.hasOwn(materialFailureMessages, raw['failureCode']) ? raw['failureCode'] : null,
    createdAt: materialText(raw['createdAt']), updatedAt: materialText(raw['updatedAt']) };
}
export function materialDownloadHref(endpoint: unknown, courseId: string, materialId: string): string | null {
  if (!isMaterialId(courseId) || !isMaterialId(materialId) || endpoint !== `/api/v1/courses/${courseId}/materials/${materialId}/download`) return null;
  const base = (import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:5000').replace(/\/$/, '');
  return `${base}${endpoint}`;
}
export function toStudentMaterial(value: unknown, courseId: string): StudentMaterial | null {
  const raw = materialRecord(value);
  if (!isMaterialId(raw['id']) || !materialDownloadHref(raw['downloadEndpoint'], courseId, raw['id'])) return null;
  return { id: raw['id'], title: materialText(raw['title'], 120), lectureId: materialLecture(raw['lectureId']), pageCount: materialCount(raw['pageCount']), downloadEndpoint: raw['downloadEndpoint'] as string };
}
export function toCourseTutorReply(value: unknown): CourseTutorReply {
  const raw = materialRecord(value);
  const outcome = ['ANSWERED', 'NO_RELEVANT_SOURCE', 'RAG_UNAVAILABLE', 'RAG_LIMIT_REACHED'].includes(String(raw['outcome'])) ? raw['outcome'] as CourseTutorOutcome : 'RAG_UNAVAILABLE';
  const citations = outcome === 'ANSWERED' && Array.isArray(raw['citations']) ? raw['citations'].flatMap(value => {
    const citation = materialRecord(value); const start = materialCount(citation['pageStart']); const end = materialCount(citation['pageEnd']);
    return isMaterialId(citation['materialId']) && start >= 1 && end >= start && end <= 100
      ? [{ materialId: citation['materialId'], title: materialText(citation['title'], 120), pageStart: start, pageEnd: end }] : [];
  }) : [];
  return { outcome, answer: outcome === 'ANSWERED' ? materialText(raw['answer'], 12000) : '', citations };
}
export function validMaterialFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  if (!/\.pdf$/i.test(file.name) || file.type !== 'application/pdf') return 'Choose a PDF file (.pdf, application/pdf) with selectable text.';
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) return 'Choose a non-empty PDF that is 10 MB or smaller.';
  return null;
}

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
  return {
    ...(s && typeof s === 'object' ? s : {}),
    writtenAnswer: String(s?.writtenAnswer ?? s?.answer ?? ''),
    fileDownloadEndpoint: typeof s?.file?.downloadEndpoint === 'string'
      ? s.file.downloadEndpoint
      : typeof s?.fileDownloadEndpoint === 'string' ? s.fileDownloadEndpoint : undefined
  };
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
export const shouldRefreshPlayback = (isPreview: boolean, playbackRefreshes: number) => !isPreview && playbackRefreshes === 0;
export const MAX_UPLOAD_MB = 25;
export const ALLOWED_SUBMISSION_TYPES = ['.pdf', '.docx', '.zip', '.png', '.jpg', '.jpeg'];
export function validSubmissionFile(f: { name: string; size: number }) {
  const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
  if (!ALLOWED_SUBMISSION_TYPES.includes(ext)) return 'Allowed file types: PDF, DOCX, ZIP, PNG, JPG/JPEG.';
  if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Files must be ${MAX_UPLOAD_MB} MB or smaller.`;
  return null;
}
