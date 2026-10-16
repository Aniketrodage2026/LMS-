# Secure Premium Video Delivery Design

## Goal

Prevent a paid-course lecture video from being played through a permanent, shareable Cloudinary URL. Preserve public playback for free-course lessons and each course's optional preview lecture.

## Scope

This task covers Cloudinary delivery behavior for new and existing lecture videos, the protected lecture response, course access-type changes, migration of existing paid videos, and automated verification. It does not add a new video provider, DRM, a backend streaming proxy, or changes to assignment-file delivery.

## Access policy

| Course / lecture state | Cloudinary delivery | Browser response |
| --- | --- | --- |
| Free course lecture | Public | Public video URL |
| Paid-course preview lecture | Public | Public video URL |
| Paid-course non-preview lecture | Authenticated + token access | Short-lived tokenized video URL after access check |

The existing backend course-access checks remain the authority for paid-course access. A student needs the appropriate purchase or enrollment. An instructor or admin can access lectures only when the existing course-management authorization permits it. A request that is not authorized must not receive a playable URL.

## Backend design

1. Add an explicit delivery classification to a lecture's stored media data so public and authenticated assets can be identified without inferring state from a URL.
2. Upload a non-preview lecture to an authenticated Cloudinary delivery type when its course is paid. Upload free-course and preview lectures as public assets.
3. Before returning a paid, non-preview lecture, perform the existing access check and generate a tokenized Cloudinary URL with a configurable expiry. The backend supplies Cloudinary's token key; the browser never receives it. Do not return the stored permanent URL.
4. Keep the current preview endpoint public and return only the preview lecture's public URL.
5. When a course changes between `FREE` and `PAID`, rename each applicable non-preview Cloudinary asset to its matching delivery type and update its stored classification. Preview lectures remain public.
6. Provide a repeatable migration command for existing paid-course, non-preview assets. It processes one asset at a time, updates MongoDB only after Cloudinary succeeds, reports failures, and can be rerun safely.

The deployment configuration adds `CLOUDINARY_AUTH_TOKEN_KEY` and `CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS`. The duration defaults to 600 seconds when the latter is not set. The token key is obtained from Cloudinary and remains server-only.

## Failure handling

- A Cloudinary upload, delivery-type update, tokenized-URL generation, or migration failure returns the existing structured error format with a user-safe message.
- The database must not claim a delivery change that Cloudinary did not complete.
- A failed migration retains the original asset and records enough output for the operator to retry it.
- Public URLs must never be substituted as a fallback for a protected paid lecture.

## Frontend impact

The protected lecture API continues to return a `secureUrl`/playable URL field, so the video player can continue using the existing request flow. The URL becomes temporary for protected lectures. No permanent asset URL is stored in frontend state or displayed in the UI. A player refreshes the lecture API after a temporary URL expires.

## Verification

Automated backend tests will prove that:

1. A purchased or enrolled student receives a tokenized, short-lived URL for a paid non-preview lecture.
2. An unauthorized user receives no lecture URL.
3. Free-course and preview lectures remain public.
4. Uploading or changing course access type selects the correct Cloudinary delivery behavior.
5. Cloudinary failures do not create a partial MongoDB update.
6. The migration is idempotent and reports failures without deleting source assets.

## Out of scope

- DRM or prevention of screen recording.
- Backend video streaming or downloading proxy.
- Private assignment uploads.
- AI learning features.
