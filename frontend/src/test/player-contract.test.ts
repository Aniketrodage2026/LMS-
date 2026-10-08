import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as models from '@/lib/api/models';
import { toLearning } from '@/lib/api/hooks';

const source = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

describe('learner player backend contract', () => {
  it('normalizes the progress response with numeric completedLectures and per-lecture state', () => {
    expect(models.toLearningProgress).toBeTypeOf('function');
    expect(models.toLearningProgress?.({
      completionPercent: 50,
      totalLectures: 2,
      completedLectures: 1,
      lectures: [{ id: 'lecture-1', title: 'Welcome', watchedSeconds: 42, watchedPercent: 35, durationSeconds: 120, completed: true }],
    })).toEqual({
      completionPercent: 50,
      totalLectures: 2,
      completedLectures: 1,
      lectures: [{ id: 'lecture-1', title: 'Welcome', watchedSeconds: 42, watchedPercent: 35, durationSeconds: 120, completed: true }],
    });
  });

  it('uses progress lectures, exact patch fields, and the public preview endpoint', () => {
    const page = source('../components/skillforge/assessment-pages.tsx');

    expect(page).toContain('toLearningProgress');
    expect(page).toContain('const lectures = progress.data?.lectures ?? [];');
    expect(page).not.toContain('course.data?.lectures');
    expect(page).toContain('const body = progressPayload(pos, authoritativeDuration, v.duration);');
    expect(page).toContain('api(`/courses/${id}/preview`)');
    expect(page).toContain('completionPercent');
  });

  it('renders backend quiz prompts and retains assignment public response fields', () => {
    const page = source('../components/skillforge/assessment-pages.tsx');

    expect(page).toContain('q?.prompt ?? q?.question ?? q?.text');
    expect(page).toContain('textarea name="writtenAnswer"');
    expect(page).toContain('.map(toSubmission)');
    expect(page).toContain('s.fileUrl');
  });

  it('resets player state per course and lecture selection before changing lessons', () => {
    const page = source('../components/skillforge/assessment-pages.tsx');

    expect(page).toContain('<Player key={`${id}:${lecture ?? \'\'}`} id={id} initial={lecture} />');
    expect(page).toContain('const save = useCallback((keepalive = false, force = false) =>');
    expect(page).toContain('const selectLecture = (next: string | undefined) => { if (!next || next === current) return; save(false, true); setCurrentId(next); };');
  });

  it('uses authoritative server duration when media duration is fractional', () => {
    expect(models.progressPayload).toBeTypeOf('function');
    expect(models.progressPayload?.(300.8, 300)).toEqual({ watchedSeconds: 300, durationSeconds: 300 });
    expect(models.progressPayload?.(300.8, 301)).toEqual({ watchedSeconds: 300, durationSeconds: 301 });

    const page = source('../components/skillforge/assessment-pages.tsx');
    expect(page).toContain('progressPayload(pos, authoritativeDuration, v.duration)');
    expect(page).toContain('const progressDuration = Number(lectures.find(lecture => lecture.id === current)?.durationSeconds ?? 0);');
    expect(page).toContain('const authoritativeDuration = progressDuration > 0 ? progressDuration : Number(lec.data?.duration ?? 0) || 0;');
    expect(page).not.toContain('durationSeconds: Math.floor(v.duration)');
  });

  it('uses finite media duration only when the server has no lecture duration', () => {
    expect(models.progressPayload?.(61.8, 0, 90.5)).toEqual({ watchedSeconds: 61, durationSeconds: 90.5 });
    expect(models.progressPayload?.(301.8, 301, 90.5)).toEqual({ watchedSeconds: 301, durationSeconds: 301 });
    expect(models.progressPayload?.(61.8, 0, Number.POSITIVE_INFINITY)).toEqual({ watchedSeconds: 0, durationSeconds: 0 });

    const page = source('../components/skillforge/assessment-pages.tsx');
    expect(page).toContain('const body = progressPayload(pos, authoritativeDuration, v.duration);');
    expect(page).toContain('if (!v || !current) return;');
    expect(page).toContain('const hasDuration = authoritativeDuration > 0 || Number.isFinite(v.duration) && v.duration > 0;');
    expect(page).toContain('if (!hasDuration) return;');
  });

  it('does not save through the effect cleanup after a lesson switch', () => {
    const page = source('../components/skillforge/assessment-pages.tsx');

    expect(page).toContain("return () => { clearInterval(t); window.removeEventListener('beforeunload', leave); document.removeEventListener('visibilitychange', vis); }; }, [save]);");
    expect(page).toContain('const selectLecture = (next: string | undefined) => { if (!next || next === current) return; save(false, true); setCurrentId(next); };');
  });

  it('uses completionPercent returned by My Learning', () => {
    expect(toLearning({ course: { _id: 'course-1', title: 'Course' }, completionPercent: 67, completedLectures: 2 })).toMatchObject({
      progress: 67,
      completedCount: 2,
    });
  });
});
