# Secure Premium Video Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Deliver paid non-preview course videos through short-lived Cloudinary authentication tokens only after the LMS authorizes the request.

**Architecture:** Store each lecture's Cloudinary delivery type alongside its media identifiers. A focused video-delivery service owns Cloudinary upload options, tokenized URL generation, and delivery-type migration; course controllers retain authorization and persistence responsibilities. A migration script moves existing paid non-preview assets to authenticated delivery, while the React player refreshes an expired temporary URL once.

**Tech Stack:** Node.js, Express 5, Mongoose 8, Cloudinary Node SDK 2, Node test runner/Supertest, React 19, TanStack Query, Vitest.

---

## File structure

- Create \`backend/services/video-delivery.service.js\` — video delivery types, Cloudinary upload options, protected URL generation, and delivery migration.
- Create \`backend/scripts/migrate-premium-video-delivery.js\` — dry-run-first, repeatable legacy migration CLI.
- Create \`backend/tests/video-delivery.service.test.js\` and \`backend/tests/premium-video-migration.test.js\`.
- Modify \`backend/models/course.schema.js\`, \`backend/controller/course.controller.js\`, \`backend/config/env.js\`, \`backend/server.js\`, and \`backend/.env.example\`.
- Modify \`backend/tests/course-access.test.js\`, \`backend/tests/course-model.test.js\`, and \`backend/tests/env.test.js\`.
- Modify \`frontend/src/components/skillforge/assessment-pages.tsx\` and \`frontend/src/test/player-contract.test.ts\`.

### Task 1: Add delivery metadata and a focused video-delivery service

**Files:**
- Create: \`backend/services/video-delivery.service.js\`
- Create: \`backend/tests/video-delivery.service.test.js\`
- Modify: \`backend/models/course.schema.js\`
- Modify: \`backend/tests/course-model.test.js\`

- [ ] **Step 1: Write failing tests for media metadata and protected URL generation**

\`\`\`js
test('lecture media defaults to PUBLIC and rejects unknown delivery types', async () => {
  const course = new Course({ ...validCourse(), lectures: [validLecture()] });
  await course.validate();
  assert.equal(course.lectures[0].lecture.deliveryType, 'PUBLIC');

  course.lectures[0].lecture.deliveryType = 'SECRET';
  await assert.rejects(() => course.validate(), /deliveryType/);
});

test('authenticated playback URL receives an expiring Cloudinary token', () => {
  const cloudinary = { url: (_id, options) => String(options.auth_token.duration) };
  const service = createVideoDeliveryService({ cloudinary, authTokenKey: 'key', tokenDurationSeconds: 600 });
  assert.equal(service.playbackUrl({ public_id: 'lms/video', deliveryType: 'AUTHENTICATED' }), '600');
});

test('authenticated playback fails safely without the server token key', () => {
  const service = createVideoDeliveryService({ cloudinary: { url() {} }, authTokenKey: '', tokenDurationSeconds: 600 });
  assert.throws(() => service.playbackUrl({ public_id: 'lms/video', deliveryType: 'AUTHENTICATED' }), /temporarily unavailable/);
});
\`\`\`

- [ ] **Step 2: Verify RED**

Run: \`Set-Location backend; npm test -- tests/course-model.test.js tests/video-delivery.service.test.js\`

Expected: FAIL because \`deliveryType\` and the service do not exist.

- [ ] **Step 3: Implement the minimal model and service**

Add to \`lecture.lecture\` in \`course.schema.js\`:

\`\`\`js
deliveryType: { type: String, enum: ['PUBLIC', 'AUTHENTICATED'], default: 'PUBLIC', required: true }
\`\`\`

Create a service exporting \`PUBLIC\`, \`AUTHENTICATED\`, and \`createVideoDeliveryService\`. Its contract is:

\`\`\`js
const service = createVideoDeliveryService({ cloudinary, authTokenKey, tokenDurationSeconds });
service.deliveryTypeFor({ accessType, isPreview }); // PUBLIC or AUTHENTICATED
service.uploadOptions({ accessType, isPreview });   // { folder, resource_type: 'video', chunk_size, type }
service.playbackUrl(media);                         // stored public URL or tokenized authenticated URL
service.renameDelivery({ publicId, from, to });     // Cloudinary rename with type/to_type
\`\`\`

\`playbackUrl\` must call \`cloudinary.url(media.public_id, { secure: true, resource_type: 'video', type: 'authenticated', sign_url: true, auth_token: { key: authTokenKey, duration } })\` for authenticated media. Duration must default to 600 and only allow integers 60–3600. Missing token key must throw \`AppError\` with code \`VIDEO_DELIVERY_UNAVAILABLE\`.

- [ ] **Step 4: Verify GREEN**

Run: \`Set-Location backend; npm test -- tests/course-model.test.js tests/video-delivery.service.test.js\`

Expected: PASS.

- [ ] **Step 5: Commit**

\`\`\`powershell
git add backend/models/course.schema.js backend/services/video-delivery.service.js backend/tests/course-model.test.js backend/tests/video-delivery.service.test.js
git commit -m "feat: add protected video delivery service"
\`\`\`

### Task 2: Add server-only token configuration

**Files:**
- Modify: \`backend/config/env.js\`
- Modify: \`backend/server.js\`
- Modify: \`backend/.env.example\`
- Modify: \`backend/tests/env.test.js\`

- [ ] **Step 1: Write failing configuration tests**

\`\`\`js
test('loadEnv reads a bounded optional Cloudinary token duration', () => {
  const config = loadEnv(baseEnvironment({
    JWT_SECRET: 'canonical-jwt-secret',
    CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS: '900'
  }));
  assert.equal(config.cloudinaryAuthTokenDurationSeconds, 900);
});

test('loadEnv rejects an invalid Cloudinary token duration', () => {
  assert.throws(
    () => loadEnv(baseEnvironment({ JWT_SECRET: 'canonical-jwt-secret', CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS: 'nope' })),
    /CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS must be an integer between 60 and 3600/
  );
});
\`\`\`

- [ ] **Step 2: Verify RED**

Run: \`Set-Location backend; npm test -- tests/env.test.js\`

Expected: FAIL because token duration is not parsed.

- [ ] **Step 3: Implement configuration**

In \`loadEnv\`, parse \`CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS\` as 600 when absent; reject non-integers and values outside 60–3600; return it as \`cloudinaryAuthTokenDurationSeconds\`.

In \`server.js\`, preserve the existing Cloudinary configuration and conditionally add:

\`\`\`js
...(process.env.CLOUDINARY_AUTH_TOKEN_KEY
  ? { auth_token: { key: process.env.CLOUDINARY_AUTH_TOKEN_KEY } }
  : {})
\`\`\`

In \`.env.example\`, add only placeholders:

\`\`\`dotenv
CLOUDINARY_AUTH_TOKEN_KEY=your-cloudinary-auth-token-key
CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS=600
\`\`\`

Never return the key in API responses or client code.

- [ ] **Step 4: Verify GREEN and commit**

Run: \`Set-Location backend; npm test -- tests/env.test.js\`

Then:

\`\`\`powershell
git add backend/config/env.js backend/server.js backend/.env.example backend/tests/env.test.js
git commit -m "feat: configure premium video token delivery"
\`\`\`

### Task 3: Return a safe, tokenized lecture DTO after existing access checks

**Files:**
- Modify: \`backend/controller/course.controller.js\`
- Modify: \`backend/tests/course-access.test.js\`

- [ ] **Step 1: Write failing API tests**

Add tests that prove:

\`\`\`js
// Enrolled student: body.lecture.secureUrl is the mocked tokenized URL,
// and JSON.stringify(body) does not include the stored permanent secure_url.

// Unenrolled student: status 403, body.lecture is undefined.

// Public preview: public secureUrl remains available without login.

// Free enrolled lesson: uses its stored public URL and exposes no public_id.
\`\`\`

Use \`t.mock.method(cloudinary.v2, 'url', () => 'https://cdn.example/video.mp4?__cld_token__=temporary')\` for the protected URL assertion.

- [ ] **Step 2: Verify RED**

Run: \`Set-Location backend; npm test -- tests/course-access.test.js\`

Expected: FAIL because the protected endpoint returns the stored Mongoose lecture object.

- [ ] **Step 3: Implement a safe response shape**

Create a controller-local helper:

\`\`\`js
function lectureResponse(lecture, secureUrl) {
  return {
    id: String(lecture._id),
    title: lecture.title,
    description: lecture.description,
    durationSeconds: Number(lecture.durationSeconds ?? 0),
    isPreview: Boolean(lecture.isPreview),
    secureUrl
  };
}
\`\`\`

After the current \`canLearnCourse\` / revoked-access checks, generate \`secureUrl\` through the new service and return \`lectureResponse\`. Do not send \`public_id\`, \`deliveryType\`, the original \`secure_url\`, or the Mongoose subdocument. Use the same helper for the public preview endpoint with its public stored URL.

- [ ] **Step 4: Verify GREEN and commit**

Run: \`Set-Location backend; npm test -- tests/course-access.test.js\`

Then:

\`\`\`powershell
git add backend/controller/course.controller.js backend/tests/course-access.test.js
git commit -m "feat: issue temporary URLs for premium lectures"
\`\`\`

### Task 4: Upload and transition the correct delivery type

**Files:**
- Modify: \`backend/controller/course.controller.js\`
- Modify: \`backend/tests/course-access.test.js\`

- [ ] **Step 1: Write failing tests**

Add tests to verify:

1. A paid non-preview upload passes \`type: 'authenticated'\` to \`cloudinary.v2.uploader.upload\` and stores \`deliveryType: 'AUTHENTICATED'\`.
2. A paid preview and every free-course upload pass \`type: 'upload'\` and store \`PUBLIC\`.
3. A \`FREE → PAID\` or \`PAID → FREE\` course update renames only non-preview assets with \`resource_type: 'video'\`, the correct \`type\` and \`to_type\`, and changes their stored delivery metadata.
4. A rename failure leaves the database course access type and all delivery metadata unchanged.
5. A course-save failure after renames attempts compensating renames back to their original delivery type.

- [ ] **Step 2: Verify RED**

Run: \`Set-Location backend; npm test -- tests/course-access.test.js\`

Expected: FAIL because upload options do not set delivery type and access-type updates do not migrate assets.

- [ ] **Step 3: Implement upload and saga-style transition**

Calculate \`isPreview\` before uploading. Call \`videoDelivery.uploadOptions({ accessType: course.accessType, isPreview })\` and persist its \`deliveryTypeFor\` result.

For an access-type change, build a transition list from non-preview lectures whose desired delivery type differs. Call \`renameDelivery\` for every transition before mutating the in-memory course document. If any rename fails, attempt to revert completed renames and return \`VIDEO_DELIVERY_UNAVAILABLE\` without saving. If \`course.save()\` fails, revert all successful renames and restore the in-memory metadata before returning the normal safe course error. Preview assets are never transitioned.

- [ ] **Step 4: Verify GREEN and commit**

Run: \`Set-Location backend; npm test -- tests/course-access.test.js\`

Then:

\`\`\`powershell
git add backend/controller/course.controller.js backend/services/video-delivery.service.js backend/tests/course-access.test.js
git commit -m "feat: protect paid lecture media uploads"
\`\`\`

### Task 5: Implement repeatable migration for existing paid videos

**Files:**
- Create: \`backend/scripts/migrate-premium-video-delivery.js\`
- Create: \`backend/tests/premium-video-migration.test.js\`

- [ ] **Step 1: Write failing migration tests**

Write tests for an exported \`migratePremiumVideoDelivery({ Course, videoDelivery, dryRun, logger })\` function:

\`\`\`js
// Paid non-preview PUBLIC lecture: rename called; DB deliveryType becomes AUTHENTICATED.
// Preview, FREE, and already AUTHENTICATED lectures: skipped.
// Cloudinary rename failure: DB remains PUBLIC, result.failed increments, later rows still process.
// dryRun: no rename and no DB write.
\`\`\`

- [ ] **Step 2: Verify RED**

Run: \`Set-Location backend; npm test -- tests/premium-video-migration.test.js\`

Expected: FAIL because the migration module does not exist.

- [ ] **Step 3: Implement migration and CLI**

The exported function must query paid courses, process each non-preview public lecture individually, call \`renameDelivery({ publicId, from: PUBLIC, to: AUTHENTICATED })\`, and only then issue a targeted \`Course.updateOne\` matching both course and lecture IDs. It must log only course ID, lecture ID, and a safe error message; it must continue after a row failure and return \`{ scanned, migrated, skipped, failed }\`.

The CLI must load dotenv, call \`loadEnv\`, configure Cloudinary (including optional token key), connect to MongoDB, support exactly \`--dry-run\` or no argument, and close Mongoose in a \`finally\` block. It exits 1 when \`failed > 0\`.

- [ ] **Step 4: Verify GREEN and commit**

Run: \`Set-Location backend; npm test -- tests/premium-video-migration.test.js\`

Then:

\`\`\`powershell
git add backend/scripts/migrate-premium-video-delivery.js backend/tests/premium-video-migration.test.js
git commit -m "feat: migrate legacy premium videos to protected delivery"
\`\`\`

### Task 6: Refresh one expired protected video URL in the React player

**Files:**
- Modify: \`frontend/src/components/skillforge/assessment-pages.tsx\`
- Modify: \`frontend/src/test/player-contract.test.ts\`

- [ ] **Step 1: Write a failing contract test**

\`\`\`ts
it('refreshes one protected lecture URL when the browser video request fails', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/components/skillforge/assessment-pages.tsx'), 'utf8');
  expect(page).toContain('const playbackRefreshes = useRef(0);');
  expect(page).toContain('void lec.refetch();');
  expect(page).toContain('playbackRefreshes.current === 0');
});
\`\`\`

- [ ] **Step 2: Verify RED**

Run: \`Set-Location frontend; npm test -- player-contract.test.ts\`

Expected: FAIL because the video player has no bounded refresh behavior.

- [ ] **Step 3: Implement a single bounded refresh**

Add \`const playbackRefreshes = useRef(0);\`. Reset it when selecting a different lecture. Add this to the lesson video element:

\`\`\`tsx
onError={() => {
  if (!isPreview && playbackRefreshes.current === 0) {
    playbackRefreshes.current += 1;
    void lec.refetch();
  }
}}
\`\`\`

Do not retry preview videos and do not retry more than once.

- [ ] **Step 4: Verify GREEN and commit**

Run: \`Set-Location frontend; npm test -- player-contract.test.ts\`

Then:

\`\`\`powershell
git add frontend/src/components/skillforge/assessment-pages.tsx frontend/src/test/player-contract.test.ts
git commit -m "feat: refresh expired premium video links"
\`\`\`

### Task 7: Verify end-to-end behavior and document the operator workflow

**Files:**
- Modify: \`backend/README.md\` only if it lacks migration instructions.

- [ ] **Step 1: Run full automated verification**

\`\`\`powershell
Set-Location backend; npm test
Set-Location ..\frontend; npm test; npm run build
Set-Location ..; git diff --check
\`\`\`

Expected: backend tests pass, frontend tests pass, frontend build passes, and no whitespace errors occur in Task 1 files.

- [ ] **Step 2: Validate with a non-production Cloudinary asset**

1. Set the real \`CLOUDINARY_AUTH_TOKEN_KEY\` and \`CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS=600\` only in local/deployment secrets.
2. Upload a paid non-preview test lecture and confirm Cloudinary marks it \`authenticated\`.
3. Confirm its stored/bare asset URL does not play.
4. Confirm an enrolled test student receives and plays an API-issued tokenized URL.
5. Confirm an unenrolled student gets \`COURSE_PURCHASE_REQUIRED\` and no URL.
6. Confirm a preview plays without login.
7. Run the migration with \`--dry-run\` before its real command.

- [ ] **Step 3: Add migration documentation if missing**

Add:

\`\`\`powershell
node scripts/migrate-premium-video-delivery.js --dry-run
node scripts/migrate-premium-video-delivery.js
\`\`\`

Document that the dry run must be reviewed before the real migration.

- [ ] **Step 4: Commit documentation only if it changed**

\`\`\`powershell
git add backend/README.md
git commit -m "docs: document premium video migration"
\`\`\`

