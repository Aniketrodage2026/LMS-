# Duplicate signup guidance

## Goal

When registration fails because an email address already belongs to an account, help the person recover instead of leaving them with a generic API error.

## Scope

This change applies only to the registration and login pages. It does not alter account creation rules or broaden error handling across the LMS.

## Behaviour

The backend continues to reject an existing email address. The frontend recognises that conflict and replaces the generic inline error with:

> An account already exists for this email. Sign in instead, or reset your password if you do not remember it.

The guidance includes direct links to the login page and password-reset page. The entered email address is preserved in the registration field so the user does not need to type it again.

Other registration failures retain the existing inline error component and safe server/client error messages.

When login credentials are invalid, the UI replaces the current raw server wording with:

> We couldn’t sign you in with that email and password. Check your details or reset your password.

This deliberately does not say whether the email address exists. It includes a password-reset link.

## Implementation boundaries

- Keep authentication authority and duplicate-email detection on the backend.
- Keep server error details out of the UI except safe 4xx messages.
- Do not create a second account, automatically log in, or reveal any account information.
- Add frontend tests for duplicate-registration and invalid-login guidance and their recovery links.

## Acceptance criteria

- A duplicate-email registration response shows the approved message.
- Login and password-reset links are available from the message.
- Non-duplicate failures continue to show their normal error message.
- Invalid login credentials show the approved safe message and a password-reset link.
- Existing authentication and frontend tests remain green.
