import { describe, expect, it } from 'vitest';
import * as models from './models';

const { inr, toCourse, toLearningCoach, toLecture, toUser } = models;

describe('API contract adapters', () => {
  it('maps the backend lecture media URL and duration', () => {
    expect(toLecture({ _id: 'lecture-1', lecture: { secure_url: 'https://cdn.example/lesson.mp4' }, durationSeconds: 321 })).toMatchObject({
      id: 'lecture-1',
      videoUrl: 'https://cdn.example/lesson.mp4',
      duration: 321,
    });
  });

  it('converts learner-entered rupees to paise and formats backend paise', () => {
    expect(models.toPaise).toBeTypeOf('function');
    expect(models.toPaise?.(1499)).toBe(149900);
    expect(inr(149900)).toBe('₹1,499');
  });

  it('normalizes course lecture counts and instructor full names', () => {
    expect(toCourse({ price: 149900, numberOflectures: 4, instructor: { _id: 'teacher-1', fullName: 'Ada Teacher' } })).toMatchObject({
      price: 149900,
      lectureCount: 4,
      instructorName: 'Ada Teacher',
    });
  });

  it('normalizes public assignment response fields', () => {
    expect(toUser({ _id: 'student-1', fullName: 'Student Name' })?.name).toBe('Student Name');
    expect(models.toSubmission).toBeTypeOf('function');
    expect(models.toSubmission?.({ writtenAnswer: 'Finished work', file: { downloadEndpoint: '/courses/course-1/assignments/a-1/submissions/s-1/file' } })).toMatchObject({
      writtenAnswer: 'Finished work',
      fileDownloadEndpoint: '/courses/course-1/assignments/a-1/submissions/s-1/file',
    });
  });

  it('accepts only bounded allowlisted learning-coach actions', () => {
    const action = {
      kind: 'CONTINUE_LESSON', courseId: '111111111111111111111111', sourceId: '222222222222222222222222',
      courseTitle: 'JavaScript foundations', title: 'Continue: Functions',
      reason: 'This is your next incomplete lesson.', minutes: 30, priority: 55, dueAt: null, scheduledToday: false,
    };
    expect(toLearningCoach({ message: 'Here are your next steps.', actions: [action] })).toMatchObject({ actions: [action] });
    expect(toLearningCoach({ message: 'Unsafe', actions: [{ ...action, kind: 'BUY_COURSE' }] })).toBeNull();
    expect(toLearningCoach({ message: 'Unsafe', actions: [{ ...action, sourceId: 'not-an-id' }] })).toBeNull();
    expect(toLearningCoach({ message: 'Unsafe', actions: Array.from({ length: 4 }, () => action) })).toBeNull();
  });
});
