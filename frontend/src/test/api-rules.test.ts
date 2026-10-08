import { describe, expect, it } from 'vitest';
import { canSubmit, homeFor, monotonic, validSubmissionFile, roleOf } from '@/lib/api/models';
import { friendlyMessage } from '@/lib/api/client';

describe('API-driven rules', () => {
  it('redirects each role to its home after login', () => {
    expect(homeFor('STUDENT')).toBe('/dashboard');
    expect(homeFor('INSTRUCTOR')).toBe('/instructor');
    expect(homeFor('ADMIN')).toBe('/admin');
  });
  it('treats unknown roles as students', () => { expect(roleOf('instructor')).toBe('INSTRUCTOR'); expect(roleOf(undefined)).toBe('STUDENT'); });
  it('never moves saved watch progress backwards', () => { expect(monotonic(120, 45)).toBe(120); expect(monotonic(45, 120)).toBe(120); });
  it('blocks resubmission after a graded submission unless resubmission is requested', () => {
    expect(canSubmit(undefined)).toBe(true);
    expect(canSubmit({ status: 'GRADED' })).toBe(false);
    expect(canSubmit({ status: 'PENDING_REVIEW' })).toBe(false);
    expect(canSubmit({ status: 'RESUBMISSION_REQUESTED' })).toBe(true);
  });
  it('accepts only PDF, DOCX, ZIP, PNG, JPG/JPEG up to 25 MB', () => {
    expect(validSubmissionFile({ name: 'a.pdf', size: 1000 })).toBeNull();
    expect(validSubmissionFile({ name: 'a.JPEG', size: 1000 })).toBeNull();
    expect(validSubmissionFile({ name: 'a.exe', size: 1000 })).not.toBeNull();
    expect(validSubmissionFile({ name: 'a.zip', size: 26 * 1024 * 1024 })).not.toBeNull();
  });
  it('gives friendly messages for auth and server errors', () => {
    expect(friendlyMessage(401, 'jwt malformed')).toBe('Please sign in to continue.');
    expect(friendlyMessage(500, 'stack')).toMatch(/our side/);
    expect(friendlyMessage(409, 'Course already purchased')).toBe('Course already purchased');
  });
});
