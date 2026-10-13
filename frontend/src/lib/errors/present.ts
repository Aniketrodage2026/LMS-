import type { ApiError } from '../api/client';
import type { Role } from '../api/models';
import { authHref } from '../auth-navigation';

export type ErrorActionKind = 'login' | 'reset-password' | 'retry' | 'correct-input' | 'course' | 'purchases' | 'learning' | 'support' | 'back';
export type ErrorRecoveryAction = { kind: ErrorActionKind; label: string; href?: string | undefined };
export type ErrorPresentation = {
  title?: string | undefined;
  message: string;
  action?: ErrorRecoveryAction | undefined;
  actions: ErrorRecoveryAction[];
  retryable: boolean;
};
export type ErrorContext = { courseId?: string | undefined; returnTo?: string | undefined; retryLabel?: string | undefined; workspaceRole?: Role | undefined };

const connectionMessage = 'We couldn’t connect to SkillForge. Check your connection and try again.';
// Exact, static constraints approved at the course controller boundary. Do not
// accept prefixes/substrings: an appended provider or database detail is unsafe.
const courseValidationMessages = new Set([
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
]);
const retry = (label = 'Try again'): ErrorRecoveryAction => ({ kind: 'retry', label });
const reset = (returnTo?: string): ErrorRecoveryAction => ({ kind: 'reset-password', label: 'Reset password', href: authHref('/forgot-password', returnTo) });
const purchases: ErrorRecoveryAction = { kind: 'purchases', label: 'View purchases', href: '/student/purchases' };
const learning: ErrorRecoveryAction = { kind: 'learning', label: 'Go to My Learning', href: '/student/my-learning' };
const support: ErrorRecoveryAction = { kind: 'support', label: 'Contact support', href: 'mailto:help@skillforge.example' };

function presentation(message: string, actions: ErrorRecoveryAction[], retryable = false): ErrorPresentation {
  return { message, action: actions[0], actions, retryable };
}

function signIn(returnTo?: string): ErrorRecoveryAction {
  return { kind: 'login', label: 'Sign in', href: authHref('/login', returnTo) };
}

function courseAction(courseId?: string): ErrorRecoveryAction {
  return courseId
    ? { kind: 'course', label: 'View course', href: `/courses/${encodeURIComponent(courseId)}` }
    : { kind: 'course', label: 'Browse courses', href: '/courses' };
}

function workspaceAction(role: unknown): ErrorRecoveryAction {
  switch (role) {
    case 'STUDENT': return learning;
    case 'INSTRUCTOR': return { kind: 'back', label: 'Go to instructor workspace', href: '/instructor' };
    case 'ADMIN': return { kind: 'back', label: 'Go to admin workspace', href: '/admin' };
    default: return courseAction();
  }
}

/** Only approved code-based/allowlisted copy reaches the UI; other server data stays diagnostic. */
export function presentApiError(error: unknown, context: ErrorContext = {}): ErrorPresentation {
  const apiError = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error as ApiError : undefined;
  const status = apiError?.status;
  const code = typeof apiError?.code === 'string' ? apiError.code : undefined;
  const serverMessage = apiError?.serverMessage;
  const retryAction = retry(context.retryLabel);

  // Only these approved service codes override generic 5xx guidance.
  if (code === 'PAYMENT_VERIFICATION_UNAVAILABLE') {
    return presentation('Payment verification is temporarily unavailable. Do not pay again; retry verification or check your purchases shortly.', [purchases, retry('Retry verification')], true);
  }
  if (code === 'PAYMENT_ORDER_UNAVAILABLE') {
    return presentation('We couldn’t prepare your checkout. Check your purchases before trying again.', [purchases, retry('Check checkout')], true);
  }
  if (code === 'PAYMENT_ORDER_PREPARING') {
    return presentation('Your checkout is being prepared. Check the existing order again shortly; do not start another payment.', [retry('Check checkout'), purchases], true);
  }
  if (code === 'UPLOAD_UNAVAILABLE') {
    return presentation('We couldn’t upload this file. Please try again shortly.', [retry('Retry upload')], true);
  }
  // Unexpected server failures never use server copy, even with another domain code.
  if (status === 0 || (status !== undefined && status >= 500) || code === 'NETWORK_ERROR') {
    return presentation(connectionMessage, [retryAction], true);
  }

  switch (code) {
    case 'AUTH_EMAIL_EXISTS':
      return presentation('An account already exists for this email. Sign in instead, or reset your password if you do not remember it.', [{ ...signIn(context.returnTo), label: 'Log in' }, reset(context.returnTo)]);
    case 'AUTH_INVALID_CREDENTIALS':
      return presentation('We couldn’t sign you in with that email and password. Check your details or reset your password.', [reset(context.returnTo)]);
    case 'AUTH_RESET_TOKEN_INVALID':
      return presentation('This reset link has expired. Request a new one to continue.', [{ ...reset(context.returnTo), label: 'Request a new link' }]);
    case 'AUTH_UNAUTHORIZED':
    case 'AUTH_REQUIRED':
      return presentation('Please sign in to continue.', [signIn(context.returnTo)]);
    case 'AUTH_ROLE_FORBIDDEN':
      return presentation('Your account does not have permission to do that.', [workspaceAction(context.workspaceRole)]);
    case 'AUTH_USER_NOT_FOUND':
      return presentation('This user is not available. Check the user ID and try again.', [{ kind: 'correct-input', label: 'Review the user ID' }]);
    case 'ASSESSMENT_NOT_AVAILABLE':
      return presentation('This assessment is not available. Open the course to see its current assessments.', [courseAction(context.courseId)]);
    case 'ASSESSMENT_SUBMISSION_LOCKED':
      return presentation('Your submission has been graded and cannot be replaced. Check your grade and feedback in your learning workspace.', [learning]);
    case 'ASSESSMENT_REVIEW_CONFLICT':
      return presentation('This assessment has changed, has student work, or has already been reviewed. Refresh the latest assessment before making changes.', [retry('Refresh assessment')], true);
    case 'ASSESSMENT_INVALID_REQUEST':
      return presentation('Check the assessment details and try again.', [{ kind: 'correct-input', label: 'Review your details' }]);
    case 'CERTIFICATE_NOT_ELIGIBLE':
      return presentation('Complete the required lessons, pass the published quizzes, and receive grades for your assignments. Check the completion and assessment requirements below.', [context.courseId ? { kind: 'learning', label: 'Continue learning', href: `/learn/${encodeURIComponent(context.courseId)}` } : learning]);
    case 'CERTIFICATE_NOT_FOUND':
      return presentation('We could not verify this certificate. Check the verification code and try again.', [{ kind: 'back', label: 'Try another code', href: '/verify' }]);
    case 'CERTIFICATE_INVALID_REQUEST':
      return presentation('Choose a valid course to check your certificate.', [learning]);
    case 'COURSE_ACCESS_DENIED':
    case 'COURSE_NOT_PURCHASED':
    case 'COURSE_PURCHASE_REQUIRED':
      return presentation('Purchase this course to unlock its lessons.', [courseAction(context.courseId)]);
    case 'COURSE_ENROLLMENT_REQUIRED':
      return presentation('Enroll in this course to unlock its lessons.', [courseAction(context.courseId)]);
    case 'COURSE_ACCESS_REVOKED':
      return presentation('Your access to this course has been revoked. Contact support for help.', [support, learning]);
    case 'COURSE_PROGRESS_INVALID':
      return presentation('We couldn’t save your progress. Reload this lesson and try again.', [retryAction], true);
    case 'COURSE_INVALID_REQUEST':
      return presentation(typeof serverMessage === 'string' && courseValidationMessages.has(serverMessage) ? serverMessage : 'Check the course details and try again.', [{ kind: 'correct-input', label: 'Review your details' }]);
    case 'PAYMENT_ORDER_PENDING':
    case 'PAYMENT_VERIFICATION_PENDING':
      return presentation('Your payment is being confirmed. Do not pay again; check your purchases shortly.', [purchases]);
    case 'PAYMENT_ORDER_REUSABLE':
      return presentation('Resume checkout to check the existing order before reopening payment. If a payment was submitted, do not pay again.', [retry('Resume checkout')], true);
    case 'PAYMENT_CHECKOUT_UNAVAILABLE':
      return presentation('The payment window couldn’t complete checkout. Resume to check the existing order before paying.', [retry('Resume checkout'), purchases], true);
    case 'PAYMENT_ALREADY_OWNED':
      return presentation('You already own this course. Open My Learning to continue.', [learning, purchases]);
    case 'PAYMENT_ORDER_CONFLICT':
    case 'PAYMENT_VERIFICATION_CONFLICT':
    case 'PAYMENT_VERIFICATION_FAILED':
    case 'PAYMENT_VERIFICATION_INVALID':
    case 'PAYMENT_PURCHASE_NOT_FOUND':
      return presentation('We couldn’t confirm this payment. Do not pay again; check your purchases or contact support if you were charged.', [purchases, support]);
    case 'PAYMENT_COURSE_NOT_PAID':
      return presentation('This course does not need a payment. Open the course to enroll.', [courseAction(context.courseId)]);
    case 'PAYMENT_PRICE_UNAVAILABLE':
      return presentation('Checkout is unavailable for this course. Contact support for help.', [support]);
    case 'UPLOAD_FILE_REQUIRED':
      return presentation('Choose a file to upload.', [retry('Retry upload')], true);
    case 'UPLOAD_FILE_TOO_LARGE':
      return presentation('This file is too large. Choose a file smaller than the allowed limit.', [retry('Retry upload')], true);
    case 'UPLOAD_FILE_TYPE_UNSUPPORTED':
    case 'UPLOAD_FILE_TYPE_INVALID':
      return presentation('This file type is not supported. Choose one of the accepted file types.', [retry('Retry upload')], true);
  }

  if (code?.startsWith('PAYMENT_')) {
    return presentation('We couldn’t complete your payment. Try again, or contact support if you were charged.', [{ kind: 'support', label: 'Contact support', href: 'mailto:help@skillforge.example' }], true);
  }
  if (code?.startsWith('UPLOAD_')) {
    return presentation('We couldn’t upload this file. Check its size and type, then try again.', [retry('Retry upload')], true);
  }
  if (code?.startsWith('VALIDATION_') || (!code && (status === 400 || status === 422))) {
    return presentation('Check the highlighted details and try again.', [{ kind: 'correct-input', label: 'Review your details' }]);
  }
  if (status === 401) return presentation('Please sign in to continue.', [signIn(context.returnTo)]);
  if (status === 403) {
    return context.courseId
      ? presentation('Purchase this course to unlock its lessons.', [courseAction(context.courseId)])
      : presentation('Your account does not have permission to do that.', [learning]);
  }
  if (status === 404) return presentation('This item is no longer available. Browse courses to find another.', [courseAction()]);
  if (status === 429) return presentation('Too many attempts. Wait a moment and try again.', [retryAction], true);
  return presentation('We couldn’t complete this request. Try again, or contact support if the problem continues.', [retryAction], true);
}
