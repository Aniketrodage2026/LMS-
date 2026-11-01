import { isMaterialId } from "@/lib/api/models";

export const COURSE_TUTOR_HANDOFF_EVENT = "skillforge:course-tutor-handoff";

export type CourseTutorHandoff = {
  courseId: string;
  lectureId?: string;
};

export function requestCourseTutorHandoff(courseId: string, lectureId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(COURSE_TUTOR_HANDOFF_EVENT, {
      detail: { courseId, ...(lectureId ? { lectureId } : {}) },
    }),
  );
}

export function readCourseTutorHandoff(event: Event): CourseTutorHandoff | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["courseId", "lectureId"].includes(key)) ||
    !isMaterialId(record.courseId) ||
    (record.lectureId !== undefined && !isMaterialId(record.lectureId))
  ) {
    return null;
  }
  return {
    courseId: record.courseId,
    ...(record.lectureId ? { lectureId: record.lectureId } : {}),
  };
}
