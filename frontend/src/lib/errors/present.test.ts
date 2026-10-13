import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { presentApiError as present } from './present';

function coded(status: number, code: string, message = 'Error: internal database details') {
  return new ApiError(status, message, undefined, { code, serverMessage: message });
}

describe('API error guidance', () => {
  it.each([
    ['STUDENT', '/student/my-learning'],
    ['INSTRUCTOR', '/instructor'],
    ['ADMIN', '/admin'],
  ] as const)('sends forbidden %s actions to their allowed workspace', (workspaceRole, href) => {
    expect(present(coded(403, 'AUTH_ROLE_FORBIDDEN'), { workspaceRole }).action?.href).toBe(href);
  });
  it.each([undefined, 'ADMIN/private', 'https://evil.example', 'instructor', {}])('uses a public fallback for unrecognized workspace role %s', workspaceRole => {
    const error = new ApiError(403, 'database secret', undefined, { code: 'AUTH_ROLE_FORBIDDEN', meta: { role: 'ADMIN' } });
    expect(present(error, { workspaceRole: workspaceRole as any }).action?.href).toBe('/courses');
  });
  it.each([
    ['ASSESSMENT_NOT_AVAILABLE', 404, 'course', /not available/i],
    ['ASSESSMENT_SUBMISSION_LOCKED', 400, 'learning', /graded/i],
    ['ASSESSMENT_REVIEW_CONFLICT', 409, 'retry', /latest|refresh/i],
    ['ASSESSMENT_INVALID_REQUEST', 400, 'correct-input', /assessment details/i],
    ['CERTIFICATE_NOT_ELIGIBLE', 409, 'learning', /lessons.*quizzes.*assignments/i],
    ['CERTIFICATE_NOT_FOUND', 404, 'back', /verification code/i],
    ['AUTH_ROLE_FORBIDDEN', 403, 'learning', /permission/i],
  ] as const)('provides safe assessment/admin recovery for %s', (code, status, kind, copy) => {
    const result = present(coded(status, code), { courseId: 'course-1', workspaceRole: 'STUDENT' });
    expect(result.action?.kind).toBe(kind);
    expect(result.message).toMatch(copy);
    expect(result.message).not.toContain('database');
    if (code === 'CERTIFICATE_NOT_ELIGIBLE') expect(result.action?.href).toBe('/learn/course-1');
  });
  it.each(['PAYMENT_ORDER_REUSABLE', 'PAYMENT_CHECKOUT_UNAVAILABLE'])('offers a safe same-order checkout recovery for %s', code => {
    const result = present(coded(400, code));
    expect(result.action).toMatchObject({ kind: 'retry', label: 'Resume checkout' });
    expect(result.retryable).toBe(true);
    expect(result.message).not.toContain('database');
  });
  it.each([
    'Title of course is required',
    'Title must be atleast 8 char',
    'Title must be less than 50 char',
    'Description is required',
    'Category is required',
    'Price must be an integer number of paise',
    'Free courses must have a price of 0',
    'Paid courses require a positive price',
    'A course can have only one preview lecture',
    'Lecture position must be a nonnegative integer',
  ])('preserves explicitly approved course validation: %s', message => {
    expect(present(coded(422, 'COURSE_INVALID_REQUEST', message))).toMatchObject({ message, retryable: false, action: { kind: 'correct-input' } });
  });

  it.each([
    'MongoDB validation failed: secret collection',
    'Title must be atleast 8 char; database password=secret',
    'Paid courses require a positive price\nError: internal stack',
  ])('hides unrecognized course validation details: %s', message => {
    expect(present(coded(422, 'COURSE_INVALID_REQUEST', message)).message).toBe('Check the course details and try again.');
  });

  it('does not use approved validation copy outside the course validation code or for 5xx', () => {
    const message = 'Title must be atleast 8 char';
    expect(present(coded(422, 'VALIDATION_FAILED', message)).message).not.toBe(message);
    expect(present(coded(500, 'COURSE_INVALID_REQUEST', message)).message).not.toBe(message);
  });

  it('shows approved duplicate-signup guidance with sign-in and reset actions', async () => {
    const result = await present(coded(409, 'AUTH_EMAIL_EXISTS'));
    expect(result.message).toBe('An account already exists for this email. Sign in instead, or reset your password if you do not remember it.');
    expect(result.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'login', href: '/login' }), expect.objectContaining({ kind: 'reset-password', href: '/forgot-password' })]));
    expect(result.retryable).toBe(false);
  });

  it('uses invalid-login guidance even though the status is 401', async () => {
    const result = await present(coded(401, 'AUTH_INVALID_CREDENTIALS'));
    expect(result.message).toBe('We couldn’t sign you in with that email and password. Check your details or reset your password.');
    expect(result.action).toMatchObject({ kind: 'reset-password', href: '/forgot-password' });
  });

  it('offers a new reset link for an expired token', async () => {
    const result = await present(coded(400, 'AUTH_RESET_TOKEN_INVALID'));
    expect(result.message).toBe('This reset link has expired. Request a new one to continue.');
    expect(result.action).toMatchObject({ label: 'Request a new link', href: '/forgot-password' });
  });

  it.each(['AUTH_EMAIL_EXISTS', 'AUTH_INVALID_CREDENTIALS', 'AUTH_RESET_TOKEN_INVALID'])('preserves a safe destination through auth recovery: %s', code => {
    const result = present(coded(400, code), { returnTo: '/learn/course-1?lesson=2' });
    const reset = result.actions.find(action => action.kind === 'reset-password');
    expect(reset?.href).toBe('/forgot-password?redirect=%2Flearn%2Fcourse-1%3Flesson%3D2');
    if (code === 'AUTH_EMAIL_EXISTS') expect(result.actions.find(action => action.kind === 'login')).toMatchObject({ label: 'Log in', href: '/login?redirect=%2Flearn%2Fcourse-1%3Flesson%3D2' });
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/login'])('does not propagate unsafe or circular auth recovery destination: %s', returnTo => {
    const result = present(coded(409, 'AUTH_EMAIL_EXISTS'), { returnTo });
    expect(result.actions.map(action => action.href)).toEqual(['/login', '/forgot-password']);
  });

  it.each(['AUTH_UNAUTHORIZED', undefined])('offers sign-in for authorization failure: %s', async code => {
    const result = await present(code ? coded(401, code) : new ApiError(401, 'jwt malformed'), { returnTo: '/student/purchases' });
    expect(result.message).toBe('Please sign in to continue.');
    expect(result.action?.href).toBe('/login?redirect=%2Fstudent%2Fpurchases');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example'])('rejects unsafe sign-in redirect context: %s', async returnTo => {
    expect((await present(new ApiError(401, ''), { returnTo })).action?.href).toBe('/login');
  });

  it.each(['COURSE_ACCESS_DENIED', 'COURSE_NOT_PURCHASED', undefined])('offers contextual course recovery: %s', async code => {
    const result = await present(code ? coded(403, code) : new ApiError(403, 'permission'), { courseId: 'course 1' });
    expect(result.message).toBe('Purchase this course to unlock its lessons.');
    expect(result.action).toMatchObject({ href: '/courses/course%201', label: 'View course' });
    expect(result.retryable).toBe(false);
  });

  it('does not claim a role restriction can be fixed by buying a course', async () => {
    const result = await present(coded(403, 'AUTH_ROLE_FORBIDDEN'), { workspaceRole: 'STUDENT' });
    expect(result.message).toBe('Your account does not have permission to do that.');
    expect(result.action?.kind).not.toBe('course');
  });

  it('uses payment support guidance without exposing provider details', async () => {
    const result = await present(coded(400, 'PAYMENT_FAILED'));
    expect(result.message).toMatch(/payment/i);
    expect(result.message).not.toContain('database');
    expect(result.action).toMatchObject({ kind: 'support', label: 'Contact support' });
  });

  it('avoids a second payment when confirmation is pending', async () => {
    const result = await present(coded(409, 'PAYMENT_ORDER_PENDING'));
    expect(result.message).toBe('Your payment is being confirmed. Do not pay again; check your purchases shortly.');
    expect(result.action).toMatchObject({ kind: 'purchases', href: '/student/purchases' });
    expect(result.retryable).toBe(false);
  });

  it('keeps verification outages actionable at 503 without prompting another payment', () => {
    const result = present(coded(503, 'PAYMENT_VERIFICATION_UNAVAILABLE'));
    expect(result.message).toMatch(/verification.*unavailable/i);
    expect(result.message).toMatch(/do not pay again/i);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'purchases', href: '/student/purchases' }),
      expect.objectContaining({ kind: 'retry', label: 'Retry verification' }),
    ]));
    expect(result.retryable).toBe(true);
    expect(result.message).not.toContain('database');
  });

  it('offers support for revoked course access without suggesting payment', () => {
    const result = present(coded(403, 'COURSE_ACCESS_REVOKED'), { courseId: 'course-1' });
    expect(result.message).toMatch(/revoked.*support/i);
    expect(result.action).toMatchObject({ kind: 'support' });
    expect(result.actions.map(action => action.kind)).not.toContain('retry');
    expect(result.actions.map(action => action.kind)).not.toContain('course');
    expect(result.retryable).toBe(false);
  });

  it('offers enrollment guidance for a free course and purchase guidance for a paid course', () => {
    expect(present(coded(403, 'COURSE_ENROLLMENT_REQUIRED'), { courseId: 'free' })).toMatchObject({
      message: 'Enroll in this course to unlock its lessons.', action: { href: '/courses/free' }, retryable: false,
    });
    expect(present(coded(403, 'COURSE_PURCHASE_REQUIRED'), { courseId: 'paid' })).toMatchObject({
      message: 'Purchase this course to unlock its lessons.', action: { href: '/courses/paid' }, retryable: false,
    });
  });

  it('offers learning and purchases for an owned course without another payment attempt', () => {
    const result = present(coded(409, 'PAYMENT_ALREADY_OWNED'));
    expect(result.actions.map(action => action.kind)).toEqual(['learning', 'purchases']);
    expect(result.retryable).toBe(false);
  });

  it('gives corrective missing-file and size guidance and safe retry for upload outages', () => {
    expect(present(coded(400, 'UPLOAD_FILE_REQUIRED'))).toMatchObject({ message: 'Choose a file to upload.', retryable: true });
    expect(present(coded(400, 'UPLOAD_FILE_TOO_LARGE'))).toMatchObject({
      message: 'This file is too large. Choose a file smaller than the allowed limit.', action: { kind: 'retry', label: 'Retry upload' },
    });
    expect(present(coded(500, 'UPLOAD_UNAVAILABLE'))).toMatchObject({
      message: 'We couldn’t upload this file. Please try again shortly.', action: { kind: 'retry', label: 'Retry upload' },
    });
  });

  it('offers upload retry and clear validation without field internals', async () => {
    expect((await present(coded(400, 'UPLOAD_FILE_INVALID'))).action?.kind).toBe('retry');
    const validation = await present(coded(422, 'VALIDATION_FAILED'));
    expect(validation.message).toBe('Check the highlighted details and try again.');
    expect(validation.action?.kind).toBe('correct-input');
  });

  it('uses safe status guidance when an Error has a non-string code', () => {
    const error = Object.assign(new Error('x'), { status: 400, code: 123 });
    expect(() => present(error)).not.toThrow();
    expect(present(error)).toMatchObject({
      message: 'Check the highlighted details and try again.',
      action: { kind: 'correct-input', label: 'Review your details' },
      retryable: false,
    });
  });

  it.each([coded(500, 'AUTH_EMAIL_EXISTS'), coded(503, 'SYSTEM_UNEXPECTED'), coded(400, 'UNKNOWN_CODE'), new Error('Error: secret stack')])('uses safe generic guidance for unknown/server failures', async error => {
    const result = await present(error);
    expect(result.message).not.toMatch(/secret|stack|database|Error:|500|503/);
    expect(result.action?.kind).toBe('retry');
  });

  it('offers connection retry for offline failures', async () => {
    const result = await present(new ApiError(0, 'Failed to fetch'));
    expect(result.message).toBe('We couldn’t connect to SkillForge. Check your connection and try again.');
    expect(result.retryable).toBe(true);
    expect(result.action?.kind).toBe('retry');
  });
});
