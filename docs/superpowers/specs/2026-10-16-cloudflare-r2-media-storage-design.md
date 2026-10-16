
# Cloudflare R2 Media Storage Design

## Goal

Replace Cloudinary as the LMS media provider with Cloudflare R2 while keeping MongoDB Atlas, existing LMS workflows, and existing Cloudinary-backed records operational throughout the migration.

## Scope

This design covers profile avatars, course thumbnails, course lecture videos, public previews, paid-video playback, and assignment-file uploads. It does not change LMS roles, purchasing, enrolment, quiz, assignment, certificate, or progress rules.

## Chosen approach

The initial migration uses backend-mediated uploads: Multer accepts existing multipart requests, validates the upload, writes a temporary local file, and a storage service uploads it to a private R2 bucket. The backend removes the temporary file in a `finally` path.

This preserves existing frontend forms and keeps R2 credentials exclusively on the backend. Direct browser-to-R2 uploads are deliberately deferred because they require new browser upload flows, signed PUT endpoints, bucket CORS rules, and client-side retry/cleanup handling.

## Storage model

Create one private R2 bucket named by `R2_BUCKET_NAME`. Do not enable public bucket access or use a public custom domain for LMS media.

Introduce a provider-neutral `storage` record alongside the legacy Cloudinary fields while both providers are in use:

```js
storage: {
  provider: 'CLOUDINARY' | 'R2',
  key: 'courses/<courseId>/lectures/<random-id>.mp4',
  contentType: 'video/mp4',
  size: 123456
}
```

Existing MongoDB records that lack `storage` are Cloudinary records. R2 objects use a random, non-PII key under these prefixes:

- `avatars/<userId>/<random-extension>`
- `courses/<courseId>/thumbnails/<random-extension>`
- `courses/<courseId>/lectures/<random-extension>`
- `assignments/<courseId>/<assignmentId>/<random-extension>`

The legacy `public_id` and `secure_url` fields remain readable during the transition. New R2 records must not treat a persistent object URL as a user-facing URL.

## Backend components

Create a focused R2 adapter backed by `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. It owns only these operations:

- upload a validated local file with an explicit content type and object key;
- delete an object by key;
- create a short-lived presigned `GetObject` URL;
- inspect object metadata when needed by migration verification.

Create a provider-neutral media service that selects R2 or the legacy Cloudinary adapter based on the document's stored provider. Controllers retain authorization, MongoDB persistence, audit events, and user-safe error responses.

All provider exceptions map to existing safe upload/media errors. Temporary files are removed whether validation, upload, database persistence, or cleanup fails. If an upload succeeds but the database write fails, delete the new R2 object as compensation. If deletion fails after a successful MongoDB deletion, return the current safe partial-cleanup error and log only safe operational context.

## Access and authorization rules

All R2 objects are private. The backend generates a short-lived R2 signed GET URL only after applying the existing authorization rule for the resource.

- A paid non-preview lecture requires the current active-enrolment/purchase check before a signed playback URL is returned.
- A preview lecture uses the existing public preview endpoint; it returns a short-lived signed R2 URL without login.
- Course thumbnails and avatars are returned as short-lived signed URLs in existing API response shapes.
- Assignment file metadata no longer contains a permanent storage URL. A dedicated download endpoint performs the existing student/instructor/admin authorization check and redirects to, or returns, a short-lived signed R2 download URL.

R2 signed URLs are bearer URLs, so their lifetime defaults to 600 seconds and must be bounded by an environment-validated setting. URLs, credentials, API secrets, and object-service errors must never appear in logs, audit records, or error messages.

## Validation policy

Multer remains the initial request parser. Existing accepted file categories remain:

- image/avatar/thumbnail: JPG, JPEG, PNG, WEBP;
- video: MP4, WEBM, MOV;
- assignment: PDF, DOCX, ZIP, PNG, JPG, JPEG.

Current maximum sizes are preserved for the migration: 200 MB for images/videos and 25 MB for assignment files. The implementation adds a centralized policy and content-signature verification before R2 upload, so a client-controlled extension or MIME value alone cannot pass validation.

## Environment variables

Only backend environment files use these values:

```dotenv
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET_NAME=lms-media-private
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_SIGNED_URL_TTL_SECONDS=600
R2_UPLOAD_MAX_IMAGE_BYTES=209715200
R2_UPLOAD_MAX_VIDEO_BYTES=209715200
R2_UPLOAD_MAX_ASSIGNMENT_BYTES=26214400
```

The R2 API token must have Object Read and Write permission scoped to the one LMS bucket. Frontend environment files never receive an R2 credential, API secret, or bucket token.

## Migration sequence

1. Create the private R2 bucket and a bucket-scoped R2 API token.
2. Add and test R2 storage services, configuration validation, schemas, and backward-compatible Cloudinary reads.
3. Send only newly uploaded media to R2 while legacy Cloudinary records continue to work.
4. Replace direct assignment-file URL responses with authorized signed-download responses.
5. Run a dry-run migration that identifies each Cloudinary-backed document and its target R2 key without changing data.
6. Run the migration in small batches. For each object: download from Cloudinary, upload to R2, verify the result, atomically update MongoDB to `provider: 'R2'`, and retain the Cloudinary source.
7. Verify access for public previews, paid students, unauthorized users, assignment owners, instructors, and admins.
8. Retain Cloudinary objects and compatibility code through a defined rollback period. Delete Cloudinary media only after a backup and an explicit post-migration approval.

The migration is idempotent: rerunning it skips already migrated R2 records and never overwrites a successful object with an unverified copy.

## Testing and acceptance criteria

- Unit tests cover R2 upload, delete, signed GET creation, invalid configuration, and provider failures through fakes.
- Controller tests prove existing role/access rules remain unchanged before an R2 URL is issued.
- Upload tests prove rejected type, size, signature, R2 upload failure, MongoDB save failure, and R2 cleanup failure return safe messages and do not leave temporary files.
- Migration tests cover dry run, resume after interruption, skipped legacy/R2 records, atomic record update, and no Cloudinary deletion.
- Manual non-production verification confirms direct unsigned R2 access fails; public preview works; purchased student playback works; unauthorized playback fails; authorized assignment file download works.

## Risks and mitigations

- Presigned URLs can be shared until expiry: use a short bounded lifetime and do not log them.
- Browser video range requests may behave differently from Cloudinary: verify playback, seeking, pause/resume, and expiry refresh with real R2 test video objects.
- Backend-mediated large video uploads depend on temporary disk capacity and request timeouts: preserve the current limit initially and assess direct signed PUT uploads only after stable deployment.
- Existing frontend queries may cache an expired image/video URL: preserve the existing one-time protected-video refresh, and refetch thumbnail/avatar data on standard query invalidation.
- Cloudinary-to-R2 copying can fail partway through: update MongoDB only after R2 verification and retain the source asset until rollback protection expires.

## Explicit non-goals

- No deletion of existing Cloudinary assets during initial R2 rollout.
- No frontend R2 credentials or direct R2 SDK use.
- No direct browser upload flow in the first migration milestone.
- No changes to MongoDB Atlas, payments, authentication, or role permissions.
