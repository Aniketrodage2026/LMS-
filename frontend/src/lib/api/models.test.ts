import { describe, expect, it } from 'vitest';
import * as models from './models';

const { inr, toCourse, toLecture, toUser } = models;

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
    expect(models.toSubmission?.({ writtenAnswer: 'Finished work', file: { secureUrl: 'https://cdn.example/work.pdf' } })).toMatchObject({
      writtenAnswer: 'Finished work',
      fileUrl: 'https://cdn.example/work.pdf',
    });
  });
});
