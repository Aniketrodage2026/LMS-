# Cloudflare R2 Media Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all new LMS media uploads and protected delivery to a private Cloudflare R2 bucket while retaining Cloudinary-backed records as a safe migration fallback.

**Architecture:** A provider-neutral media service selects R2 for new records and Cloudinary for legacy records. The backend continues to receive multipart uploads, validates and stores a temporary file, transfers it to R2, and issues short-lived signed GET URLs only after existing LMS authorization checks.

**Tech Stack:** Node.js, Express 5, Mongoose 8, Multer 2, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, Node test runner, React 19, Vitest.

---

## File structure

- Create `backend/services/r2-storage.service.js` for private R2 S3 operations.
- Create `backend/services/media-storage.service.js` for R2/Cloudinary dispatch.
- Create `backend/services/media-validation.service.js` for extension, MIME, byte-signature, and limit checks.
- Create `backend/scripts/migrate-cloudinary-media-to-r2.js` for dry-run-first migration.
- Add focused tests for each service and migration.
- Modify backend schemas, controllers, routes, configuration, documentation, and frontend API adapters only where the signed URL contract changes.

### Task 1: R2 configuration and S3-compatible adapter

**Files:**
- Create: `backend/services/r2-storage.service.js`
- Create: `backend/tests/r2-storage.service.test.js`
- Modify: `backend/package.json`, `backend/config/env.js`, `backend/.env.example`, `backend/README.md`, `backend/tests/env.test.js`

- [ ] **Step 1: Write failing tests**

```js
test('loadEnv returns validated private R2 configuration', () => {
  const config = loadEnv(baseEnvironment({
    R2_ENABLED: 'true', R2_ACCOUNT_ID: 'account',
    R2_BUCKET_NAME: 'lms-media-private', R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret', R2_SIGNED_URL_TTL_SECONDS: '600'
  }));
  assert.equal(config.r2.endpoint, 'https://account.r2.cloudflarestorage.com');
  assert.equal(config.r2.signedUrlTtlSeconds, 600);
});

test('R2 storage uploads an object and signs only a GET URL', async () => {
  const calls = [];
  const storage = createR2Storage({
    client: { send: async command => calls.push(command) },
    getSignedUrl: async () => 'https://r2.example/signed',
    config: validR2Config()
  });
  await storage.put({ key: 'courses/a/lectures/x.mp4', body: Buffer.from('x'), contentType: 'video/mp4', contentLength: 1 });
  assert.equal(await storage.getSignedUrl('courses/a/lectures/x.mp4'), 'https://r2.example/signed');
  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/env.test.js tests/r2-storage.service.test.js`

Expected: FAIL because R2 configuration and the adapter do not exist.

- [ ] **Step 3: Implement minimal R2 support**

Run:

```powershell
Set-Location backend
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Implement a factory with exactly these methods:

```js
function createR2Storage({ client, getSignedUrl, config }) {
  return {
    put: ({ key, body, contentType, contentLength }) =>
      client.send(new PutObjectCommand({ Bucket: config.bucketName, Key: key, Body: body, ContentType: contentType, ContentLength: contentLength })),
    remove: key => client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key })),
    head: key => client.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key })),
    getSignedUrl: key => getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucketName, Key: key }), { expiresIn: config.signedUrlTtlSeconds })
  };
}
```

Require R2 credentials only when `R2_ENABLED=true`. Derive the endpoint from account id unless `R2_ENDPOINT` is supplied. Bound signed URL lifetime to an integer 60–3600 seconds. Put placeholders only in `.env.example`; never return the configuration in APIs.

- [ ] **Step 4: Verify GREEN**

Run: `Set-Location backend; node --test tests/env.test.js tests/r2-storage.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/package.json backend/package-lock.json backend/config/env.js backend/.env.example backend/README.md backend/services/r2-storage.service.js backend/tests/env.test.js backend/tests/r2-storage.service.test.js
git commit -m "feat: add private R2 storage foundation"
```

### Task 2: Provider-neutral media metadata with Cloudinary compatibility

**Files:**
- Create: `backend/services/media-storage.service.js`
- Create: `backend/tests/media-storage.service.test.js`
- Modify: `backend/models/user.schema.js`, `backend/models/course.schema.js`, `backend/models/submission.schema.js`, `backend/services/assignment.service.js`
- Modify: `backend/tests/course-model.test.js`, `backend/tests/assignment-model.test.js`

- [ ] **Step 1: Write failing tests**

```js
test('legacy Cloudinary media remains readable when storage is absent', () => {
  assert.equal(providerFor({ public_id: 'legacy', secure_url: 'https://res.cloudinary.com/demo' }), 'CLOUDINARY');
});

test('R2 media requires provider, key, content type, and nonnegative size', async () => {
  const course = new Course(validCourse({ thumbnail: r2Media('courses/a/thumbnails/x.png') }));
  await course.validate();
  course.thumbnail.storage.key = '';
  await assert.rejects(() => course.validate(), /key/);
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/course-model.test.js tests/assignment-model.test.js tests/media-storage.service.test.js`

Expected: FAIL because models only understand Cloudinary fields.

- [ ] **Step 3: Implement dual-provider records**

Add an optional nested record to every stored media value:

```js
storage: {
  provider: { type: String, enum: ['CLOUDINARY', 'R2'], required: true },
  key: { type: String, required: true, trim: true },
  contentType: { type: String, required: true, trim: true },
  size: { type: Number, required: true, min: 0 }
}
```

Require either a complete legacy `{ public_id, secure_url }` record or a complete `storage` record. Implement `providerFor`, `objectKeyFor`, `uploadLocalFile`, `remove`, and `signedReadUrl`; absent `storage` selects the legacy Cloudinary adapter.

- [ ] **Step 4: Verify GREEN**

Run: `Set-Location backend; node --test tests/course-model.test.js tests/assignment-model.test.js tests/media-storage.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/models/user.schema.js backend/models/course.schema.js backend/models/submission.schema.js backend/services/assignment.service.js backend/services/media-storage.service.js backend/tests/course-model.test.js backend/tests/assignment-model.test.js backend/tests/media-storage.service.test.js
git commit -m "feat: support R2 and legacy Cloudinary media records"
```

### Task 3: Validation and R2 avatars/thumbnails

**Files:**
- Create: `backend/services/media-validation.service.js`, `backend/tests/media-validation.service.test.js`
- Modify: `backend/middleware/multer.middleware.js`, `backend/controller/user.controller.js`, `backend/controller/course.controller.js`
- Modify: focused user/course upload tests

- [ ] **Step 1: Write failing tests**

```js
test('rejects an image filename and MIME whose file signature is not an image', async () => {
  await assert.rejects(() => validateStoredUpload(fakeFile('avatar.jpg', 'image/jpeg', Buffer.from('not an image'))), /not supported/);
});

test('removes a new R2 thumbnail when its MongoDB save fails', async () => {
  const media = fakeMediaService({ saveFails: true });
  await assert.rejects(() => createCourseWithThumbnail({ media }), /course request/);
  assert.deepEqual(media.removedKeys, ['courses/course-id/thumbnails/new.png']);
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/media-validation.service.test.js tests/course-controller-compatibility.test.js`

Expected: FAIL because validation trusts browser-provided type details and controllers upload directly to Cloudinary.

- [ ] **Step 3: Implement validation-first storage**

Keep Multer disk storage and every current multipart field name. Centralize existing permitted categories and size limits; compare extension, declared MIME, byte signature, and size before R2 upload. Reject ambiguous formats with the existing safe unsupported-type response.

Replace direct Cloudinary avatar and thumbnail uploads/deletions with `mediaStorage`. New records persist R2 metadata. Always remove temporary files; after an R2 upload but before a failed MongoDB save, remove the R2 key exactly once.

- [ ] **Step 4: Verify GREEN**

Run: `Set-Location backend; node --test tests/media-validation.service.test.js tests/course-controller-compatibility.test.js tests/course-model.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/media-validation.service.js backend/tests/media-validation.service.test.js backend/middleware/multer.middleware.js backend/controller/user.controller.js backend/controller/course.controller.js backend/tests/course-controller-compatibility.test.js backend/tests/course-model.test.js
git commit -m "feat: store new avatars and thumbnails in R2"
```

### Task 4: Private R2 course video uploads and signed delivery

**Files:**
- Modify: `backend/controller/course.controller.js`, `backend/services/video-delivery.service.js`, `backend/services/media-storage.service.js`
- Modify: `backend/tests/course-access.test.js`, `backend/tests/video-delivery.service.test.js`
- Modify: `frontend/src/lib/api/models.ts`, `frontend/src/test/player-contract.test.ts`

- [ ] **Step 1: Write failing access tests**

```js
test('an enrolled student receives a short-lived R2 URL for a paid R2 lecture', async () => {
  const response = await enrolledAgent.get(`/api/v1/courses/${course.id}/lectures/${lecture.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.lecture.secureUrl, 'https://r2.example/signed-paid-video');
});

test('a visitor receives a signed URL for only the course preview', async () => {
  const response = await request(app).get(`/api/v1/courses/${course.id}/preview`);
  assert.equal(response.status, 200);
  assert.equal(response.body.lecture.secureUrl, 'https://r2.example/signed-preview');
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/course-access.test.js tests/video-delivery.service.test.js`

Expected: FAIL because video delivery only knows Cloudinary.

- [ ] **Step 3: Implement R2 access without changing authorization order**

New lecture uploads use random course-scoped R2 keys. In `getLectureByCourseId`, keep validation, course lookup, lecture lookup, active-enrolment/revocation/role checks, then generate the signed URL. Preview endpoints issue a URL only for the resolved preview. Legacy Cloudinary records continue through the current delivery service. Course/lecture deletion calls provider-neutral `remove`.

Keep frontend `secureUrl` unchanged and retain the existing one-refresh video error behavior.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
Set-Location backend; node --test tests/course-access.test.js tests/video-delivery.service.test.js
Set-Location ..\frontend; npm test -- --run src/test/player-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/controller/course.controller.js backend/services/video-delivery.service.js backend/services/media-storage.service.js backend/tests/course-access.test.js backend/tests/video-delivery.service.test.js frontend/src/lib/api/models.ts frontend/src/test/player-contract.test.ts
git commit -m "feat: deliver protected R2 course videos"
```

### Task 5: R2 assignment storage and authorized downloads

**Files:**
- Modify: `backend/controller/student-assignment.controller.js`, `backend/controller/instructor-assignment.controller.js`, `backend/routes/student-assignment.route.js`, `backend/services/assignment.service.js`
- Create: `backend/tests/assignment-file-access.test.js`
- Modify: `backend/tests/assignment-flow.test.js`, `frontend/src/components/skillforge/assessment-pages.tsx`, `frontend/src/lib/api/models.ts`

- [ ] **Step 1: Write failing access tests**

```js
test('submission summaries never expose an R2 object key or permanent provider URL', async () => {
  const response = await studentAgent.get(submissionListPath);
  assert.equal(JSON.stringify(response.body).includes('assignments/course-id/'), false);
});

test('only the owner, course manager, or admin can obtain a signed assignment download', async () => {
  assert.equal((await studentAgent.get(downloadPath)).status, 302);
  assert.equal((await otherStudentAgent.get(downloadPath)).status, 403);
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/assignment-flow.test.js tests/assignment-file-access.test.js`

Expected: FAIL because submissions expose stored provider URLs and have no download route.

- [ ] **Step 3: Implement safe file responses**

Use `mediaStorage.uploadLocalFile` for assignment files and remove the uploaded R2 object if the submission transaction fails. Add `GET /api/v1/courses/:courseId/assignments/:assignmentId/submissions/:submissionId/file`. It authorizes the student owner, course manager, or admin, then redirects to a short-lived R2 GET URL; legacy Cloudinary file records retain their compatible fallback. API summaries contain safe filename, MIME, size, and the new download endpoint, never storage key/public id/permanent URL.

- [ ] **Step 4: Verify GREEN**

Run: `Set-Location backend; node --test tests/assignment-flow.test.js tests/assignment-file-access.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/controller/student-assignment.controller.js backend/controller/instructor-assignment.controller.js backend/routes/student-assignment.route.js backend/services/assignment.service.js backend/tests/assignment-flow.test.js backend/tests/assignment-file-access.test.js frontend/src/components/skillforge/assessment-pages.tsx frontend/src/lib/api/models.ts
git commit -m "feat: secure assignment files with R2"
```

### Task 6: Idempotent Cloudinary-to-R2 migration CLI

**Files:**
- Create: `backend/scripts/migrate-cloudinary-media-to-r2.js`, `backend/tests/cloudinary-to-r2-migration.test.js`
- Modify: `backend/README.md`

- [ ] **Step 1: Write failing migration tests**

```js
test('dry run reports candidates without provider or Mongo writes', async () => {
  const report = await migrateCloudinaryMediaToR2({ dryRun: true, models, cloudinary, r2, logger });
  assert.equal(report.candidates, 3);
  assert.equal(r2.putCalls.length, 0);
});

test('a verified R2 copy atomically changes MongoDB but does not delete Cloudinary', async () => {
  await migrateCloudinaryMediaToR2({ dryRun: false, models, cloudinary, r2, logger });
  assert.equal(models.course.thumbnail.storage.provider, 'R2');
  assert.equal(cloudinary.destroyCalls.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `Set-Location backend; node --test tests/cloudinary-to-r2-migration.test.js`

Expected: FAIL because the R2 migration script does not exist.

- [ ] **Step 3: Implement the migration operator**

Accept only no arguments or `--dry-run`. Find Cloudinary media that lacks `storage.provider === 'R2'` across avatars, thumbnails, lecture media, and submission files. For each item, read the legacy bytes, upload to a random R2 key, verify with `head`, then perform a conditional MongoDB update. Continue after an item failure, report candidate/migrated/skipped/failed counts, exit nonzero for failures, and never delete a Cloudinary object. Logs contain only record type, record id, and outcome.

- [ ] **Step 4: Verify GREEN**

Run: `Set-Location backend; node --test tests/cloudinary-to-r2-migration.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/scripts/migrate-cloudinary-media-to-r2.js backend/tests/cloudinary-to-r2-migration.test.js backend/README.md
git commit -m "feat: add Cloudinary to R2 media migration"
```

### Task 7: Full verification and production runbook

**Files:**
- Modify: `backend/README.md`, `frontend/README.md`

- [ ] **Step 1: Run full automated verification**

```powershell
Set-Location backend; npm test
Set-Location ..\frontend; npm test; npm run build
Set-Location ..; git diff --check
```

Expected: backend tests, frontend tests, and the frontend production build pass.

- [ ] **Step 2: Document exact live R2 verification**

Document: private bucket; bucket-scoped Object Read & Write token; backend-only `R2_*` secrets; test uploads for avatar/thumbnail/preview/paid video/assignment; failure of unsigned object URL; preview success without login; paid playback only after purchase; assignment download only for owner/instructor/admin; dry-run migration command before real migration; retained Cloudinary rollback window.

- [ ] **Step 3: Verify and commit**

Run:

```powershell
Set-Location backend
node --check scripts/migrate-cloudinary-media-to-r2.js
git add README.md ..\frontend\README.md
git commit -m "docs: document private R2 media rollout"
```

Expected: syntax validation passes and the runbook is complete.

## Plan self-review

- R2 configuration and server-only credentials: Task 1.
- Existing Cloudinary records remain accessible: Task 2 and Task 6.
- Type/size/signature validation and safe cleanup: Task 3.
- Private signed course/video access: Task 4.
- Private authorized assignment access: Task 5.
- Dry-run-first migration and no source deletion: Task 6.
- Full testing and deployment checks: Task 7.

