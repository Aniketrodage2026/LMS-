const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { allowedByNameAndMime, categories, validateStoredUpload } = require('../services/media-validation.service');
const upload = require('../middleware/multer.middleware');
const { objectKeyFor } = require('../services/media-storage.service');

async function withFile(bytes, callback, metadata = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lms-pdf-material-'));
  const filePath = path.join(directory, 'temporary.pdf');
  await fs.writeFile(filePath, bytes);
  try {
    return await callback({ path: filePath, originalname: 'notes.pdf', mimetype: 'application/pdf', size: bytes.length, ...metadata });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Small real PDF with a correct xref, so the default parser is exercised without network/fixtures.
function textPdf(pageTexts, password) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (const text of pageTexts) {
    const contentNumber = objects.length + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    const stream = `BT /F1 12 Tf 50 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let trailerEncryption = '';
  if (password !== undefined) {
    const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
    const pad = (value) => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
    const md5 = (value) => crypto.createHash('md5').update(value).digest();
    const rc4 = (key, input) => {
      const state = Array.from({ length: 256 }, (_, i) => i);
      let j = 0;
      for (let i = 0; i < 256; i += 1) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
      let i = 0; j = 0;
      return Buffer.from(Array.from(input, (value) => {
        i = (i + 1) & 255; j = (j + state[i]) & 255;
        [state[i], state[j]] = [state[j], state[i]];
        return value ^ state[(state[i] + state[j]) & 255];
      }));
    };
    const owner = rc4(md5(pad('owner-password')).subarray(0, 5), pad(password));
    const identifier = Buffer.alloc(16, 1);
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    const key = md5(Buffer.concat([pad(password), owner, permissions, identifier])).subarray(0, 5);
    const user = rc4(key, padding);
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`);
    trailerEncryption = ` /Encrypt ${objects.length} 0 R /ID [<${identifier.toString('hex')}> <${identifier.toString('hex')}>]`;
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerEncryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('material uploads accept only PDF filename and MIME with a dedicated 10 MB Multer limit', async () => {
  assert.equal(categories.material?.maxBytes, 10 * 1024 * 1024);
  assert.equal(allowedByNameAndMime({ originalname: 'NOTES.PDF', mimetype: 'application/pdf' }, 'material'), true);
  for (const file of [
    { originalname: 'notes.docx', mimetype: 'application/pdf' },
    { originalname: 'notes.pdf', mimetype: 'application/octet-stream' },
    { originalname: 'notes.pdf.exe', mimetype: 'application/pdf' }
  ]) assert.equal(allowedByNameAndMime(file, 'material'), false);
  assert.equal(upload.material.limits.fileSize, 10485760);
  const filter = (file) => new Promise((resolve) => upload.material.fileFilter({}, file, (error, accepted) => resolve({ error, accepted })));
  assert.equal((await filter({ originalname: 'notes.pdf', mimetype: 'application/pdf' })).accepted, true);
  assert.equal((await filter({ originalname: 'notes.txt', mimetype: 'application/pdf' })).error.code, 'UPLOAD_FILE_TYPE_UNSUPPORTED');
  const name = () => new Promise((resolve) => upload.material.storage.getFilename({}, { originalname: 'notes.PDF' }, (_, value) => resolve(value)));
  const first = await name();
  assert.match(first, /^material-[a-f0-9-]{36}\.pdf$/);
  assert.notEqual(first, await name());
});

test('material signature validation rejects renamed files and material keys use the private category', async () => {
  assert.equal(objectKeyFor({ category: 'materials', extension: 'pdf', randomUUID: () => 'random' }), 'materials/random.pdf');
  await withFile(Buffer.from('renamed non-PDF'), async (file) => {
    await assert.rejects(validateStoredUpload(file, 'material'), { code: 'UPLOAD_FILE_TYPE_UNSUPPORTED' });
  });
  await withFile(Buffer.from('%PDF-1.7\nfixture'), async (file) => {
    assert.deepEqual(await validateStoredUpload(file, 'material'), { extension: 'pdf', contentType: 'application/pdf', size: file.size });
  });
});

test('PDF preparation checks metadata and magic bytes before invoking the parser', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  let calls = 0;
  const service = createPdfMaterialService({ parsePdf: async () => { calls += 1; return { pages: ['Readable source'] }; } });
  const invalid = [
    { bytes: Buffer.from('not a PDF'), metadata: {} },
    { bytes: Buffer.from('%PDF-1.7'), metadata: { originalname: 'notes.txt' } },
    { bytes: Buffer.from('%PDF-1.7'), metadata: { mimetype: 'image/png' } },
    { bytes: Buffer.from('%PDF-1.7'), metadata: { size: 10485761 } },
    { bytes: Buffer.alloc(10485761, 'a'), metadata: {} }
  ];
  for (const entry of invalid) await withFile(entry.bytes, async (file) => {
    await assert.rejects(service.preparePdf(file), (error) => ['INVALID_PDF', 'PDF_TOO_LARGE'].includes(error.code));
  }, entry.metadata);
  assert.equal(calls, 0);
});

test('PDF preparation preserves page text, computes SHA-256 and bounds extracted characters', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  const bytes = Buffer.from('%PDF-1.7\nfixture');
  await withFile(bytes, async (file) => {
    const service = createPdfMaterialService({ parsePdf: async (input) => {
      assert.deepEqual(input, bytes);
      return { pages: ['First page', '', 'Third page\nwith source text.'] };
    } });
    const result = await service.preparePdf(file);
    assert.deepEqual(result.pages, ['First page', '', 'Third page\nwith source text.']);
    assert.equal(result.pageCount, 3);
    assert.equal(result.extractedCharacterCount, 38);
    assert.equal(result.contentHash, crypto.createHash('sha256').update(bytes).digest('hex'));
  });
});

for (const [name, parsed, code] of [
  ['encrypted', { encrypted: true, pages: ['secret'] }, 'ENCRYPTED_PDF'],
  ['too many pages', { pages: Array(101).fill('readable') }, 'TOO_MANY_PAGES'],
  ['image only', { pages: ['  \n', '\u0000\u0001'] }, 'NO_READABLE_TEXT'],
  ['empty', { pages: [] }, 'INVALID_PDF'],
  ['malformed', { pages: [123] }, 'EXTRACTION_FAILED'],
  ['too much text', { pages: ['x'.repeat(1000001)] }, 'EXTRACTION_FAILED']
]) test(`PDF preparation rejects ${name} input with a safe code`, async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  await withFile(Buffer.from('%PDF-1.7'), async (file) => {
    await assert.rejects(createPdfMaterialService({ parsePdf: async () => parsed }).preparePdf(file), { code });
  });
});

test('PDF parser exceptions are redacted and password errors are classified safely', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  await withFile(Buffer.from('%PDF-1.7'), async (file) => {
    for (const [name, code] of [['PasswordException', 'ENCRYPTED_PDF'], ['Error', 'EXTRACTION_FAILED']]) {
      const service = createPdfMaterialService({ parsePdf: async () => {
        const error = new Error('sensitive source/provider body'); error.name = name; throw error;
      } });
      await assert.rejects(service.preparePdf(file), (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive/);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});

test('deterministic chunks retain exact source slices, page ranges, word targets and bounded overlap', () => {
  const { chunkPdfPages } = require('../services/pdf-material.service');
  const pages = [Array.from({ length: 800 }, (_, i) => `alpha${i}`).join(' '), '', Array.from({ length: 900 }, (_, i) => `beta${i}`).join(' ')];
  const chunks = chunkPdfPages(pages);
  assert.deepEqual(chunks, chunkPdfPages(pages));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].ordinal, 0);
  assert.equal(chunks[0].pageStart, 1);
  assert.equal(chunks[0].pageEnd, 3);
  assert.equal(chunks[1].pageStart, 3);
  assert.equal(chunks[1].pageEnd, 3);
  assert.ok(chunks[0].text.split(/\s+/).length >= 800);
  assert.ok(chunks[0].text.split(/\s+/).length <= 1200);
  const source = pages.join('\n');
  for (const chunk of chunks) {
    assert.ok(source.includes(chunk.text));
    assert.ok(chunk.text.length <= 12000);
  }
  const firstEnd = source.indexOf(chunks[0].text) + chunks[0].text.length;
  const nextStart = source.indexOf(chunks[1].text);
  assert.ok(firstEnd > nextStart && firstEnd - nextStart <= 600);
  assert.equal(chunks[1].text.at(-1), source.at(-1));
});

test('chunks split unbroken long text within 12,000 chars without losing source content', () => {
  const { chunkPdfPages } = require('../services/pdf-material.service');
  const source = 'x'.repeat(25000);
  const chunks = chunkPdfPages([source]);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.text.length > 0 && chunk.text.length <= 12000 && chunk.pageStart === 1 && chunk.pageEnd === 1));
  assert.ok(chunks.reduce((count, chunk) => count + chunk.text.length, 0) >= source.length);
});

test('embedding adapter sends only bounded document text with exact Embedding 2 model and dimensions', async () => {
  const { createRagEmbeddingService } = require('../services/rag-embedding.service');
  let request;
  const service = createRagEmbeddingService({ env: { GEMINI_API_KEY: 'test-secret', GEMINI_EMBEDDING_MODEL: 'ignored-model', RAG_EMBEDDING_DIMENSION: '42' },
    fetch: async (url, options) => {
      request = { url, ...options };
      return { ok: true, json: async () => ({ embedding: { values: Array(768).fill(0.25) } }) };
    } });
  const vector = await service.embedDocument({ title: 'Course notes', text: 'Bounded chunk', course: 'private-course', storage: 'private-R2-key' });
  assert.deepEqual(vector, Array(768).fill(0.25));
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-secret' });
  assert.deepEqual(JSON.parse(request.body), { model: 'models/gemini-embedding-2', content: { parts: [{ text: 'title: Course notes | text: Bounded chunk' }] }, outputDimensionality: 768 });
  assert.ok(request.signal instanceof AbortSignal);
  assert.doesNotMatch(request.url + request.body, /test-secret|private-course|private-R2-key/);
});

for (const [name, body] of [
  ['wrong response shape', { embeddings: [{ values: Array(768).fill(0) }] }],
  ['missing vector', { embedding: {} }],
  ['short vector', { embedding: { values: Array(767).fill(0) } }],
  ['long vector', { embedding: { values: Array(769).fill(0) } }],
  ['string value', { embedding: { values: [...Array(767).fill(0), '0.1'] } }],
  ['infinite value', { embedding: { values: [...Array(767).fill(0), Infinity] } }],
  ['NaN value', { embedding: { values: [...Array(767).fill(0), NaN] } }],
  ['null value', { embedding: { values: [...Array(767).fill(0), null] } }]
]) test(`embedding adapter rejects ${name} without exposing provider data`, async () => {
  const { createRagEmbeddingService } = require('../services/rag-embedding.service');
  const service = createRagEmbeddingService({ env: { GEMINI_API_KEY: 'test-secret' }, fetch: async () => ({ ok: true, json: async () => body }) });
  await assert.rejects(service.embedDocument({ title: 'Notes', text: 'private source text' }), (error) => {
    assert.equal(error.code, 'EMBEDDING_FAILED');
    assert.doesNotMatch(error.message + JSON.stringify(error), /test-secret|private source text|embedding.*values/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('embedding failures, malformed JSON and missing backend key are safe and never logged', async (t) => {
  const { createRagEmbeddingService } = require('../services/rag-embedding.service');
  const logs = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...values) => logs.push(values));
  let calls = 0;
  for (const fetch of [
    async () => { calls += 1; throw new Error('test-secret private source text provider body'); },
    async () => { calls += 1; return { ok: false, json: async () => { throw new Error('must not inspect error body'); } }; },
    async () => { calls += 1; return { ok: true, json: async () => { throw new SyntaxError('private provider body'); } }; }
  ]) {
    const service = createRagEmbeddingService({ env: { GEMINI_API_KEY: 'test-secret' }, fetch });
    await assert.rejects(service.embedDocument({ title: 'Notes', text: 'private source text' }), { code: 'EMBEDDING_FAILED', message: 'Material embeddings are temporarily unavailable.' });
  }
  const service = createRagEmbeddingService({ env: { VITE_GEMINI_API_KEY: 'frontend-key' }, fetch: async () => { calls += 1; } });
  await assert.rejects(service.embedDocument({ title: 'Notes', text: 'private source text' }), { code: 'EMBEDDING_FAILED' });
  assert.equal(calls, 3);
  assert.deepEqual(logs, []);
});

test('embedding adapter validates input bounds before any fetch', async () => {
  const { createRagEmbeddingService } = require('../services/rag-embedding.service');
  let calls = 0;
  const service = createRagEmbeddingService({ env: { GEMINI_API_KEY: 'test-secret' }, fetch: async () => { calls += 1; } });
  for (const input of [null, { title: '', text: 'source' }, { title: 'x'.repeat(121), text: 'source' }, { title: 'Notes', text: '' }, { title: 'Notes', text: 'x'.repeat(12001) }]) {
    await assert.rejects(service.embedDocument(input), { code: 'EMBEDDING_FAILED' });
  }
  assert.equal(calls, 0);
});

test('embedding hard timeout aborts and settles even when fetch or body reading ignores abort', async () => {
  const { createRagEmbeddingService } = require('../services/rag-embedding.service');
  for (const hangingBody of [false, true]) {
    let signal;
    const service = createRagEmbeddingService({ env: { GEMINI_API_KEY: 'test-secret' }, timeoutMs: 20,
      fetch: async (_url, options) => {
        signal = options.signal;
        return hangingBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
      } });
    const start = Date.now();
    await assert.rejects(service.embedDocument({ title: 'Notes', text: 'source' }), { code: 'EMBEDDING_FAILED' });
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - start < 2000);
  }
});

test('default server parser extracts actual PDF pages in order without remote requests', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  await withFile(textPdf(['First embedded page.', 'Second embedded page.']), async (file) => {
    const prepared = await createPdfMaterialService().preparePdf(file);
    assert.deepEqual(prepared.pages.map((text) => text.trim()), ['First embedded page.', 'Second embedded page.']);
    assert.equal(prepared.pageCount, 2);
  });
});

test('default parser rejects malformed, image-only and over-page PDFs', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  for (const [bytes, code] of [[Buffer.from('%PDF-1.7\ninvalid'), 'EXTRACTION_FAILED'], [textPdf(['']), 'NO_READABLE_TEXT'], [textPdf(Array(101).fill('Readable')), 'TOO_MANY_PAGES']]) {
    await withFile(bytes, (file) => assert.rejects(createPdfMaterialService().preparePdf(file), { code }));
  }
});

test('default parser rejects encrypted PDFs with both empty and required passwords', async () => {
  const { createPdfMaterialService } = require('../services/pdf-material.service');
  for (const password of ['', 'required-password']) await withFile(textPdf(['Secret text'], password), async (file) => {
    await assert.rejects(createPdfMaterialService().preparePdf(file), { code: 'ENCRYPTED_PDF' });
  });
});

test('public embedder interface formats bounded queries using the same vector safeguards', async () => {
  const { createRagEmbedder } = require('../services/rag-embedding.service');
  let request;
  const embedder = createRagEmbedder({ apiKey: 'server-secret', timeoutMs: 100 }, async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ embedding: { values: Array(768).fill(0.5) } }) };
  });
  assert.deepEqual(await embedder.embedQuery('  What does this course teach?  '), Array(768).fill(0.5));
  assert.equal(JSON.parse(request.body).content.parts[0].text, 'task: question answering | query: What does this course teach?');
  assert.equal(JSON.parse(request.body).outputDimensionality, 768);
  assert.equal(request.headers['x-goog-api-key'], 'server-secret');
  await assert.rejects(embedder.embedQuery('x'.repeat(2001)), { code: 'EMBEDDING_FAILED' });
  await assert.rejects(embedder.embedQuery('  '), { code: 'EMBEDDING_FAILED' });
  await assert.rejects(embedder.embedQuery({ text: 'question', identity: 'private student' }), { code: 'EMBEDDING_FAILED' });
});

test('public query embeddings reject invalid vectors and provider errors safely', async () => {
  const { createRagEmbedder } = require('../services/rag-embedding.service');
  const embedder = createRagEmbedder({ apiKey: 'server-secret' }, async () => ({ ok: true, json: async () => ({ embedding: { values: Array(767).fill(0) } }) }));
  await assert.rejects(embedder.embedQuery('Question'), { code: 'EMBEDDING_FAILED', message: 'Material embeddings are temporarily unavailable.' });
});

test.describe('private material ingestion', () => {
  const mongoose = require('mongoose');
  const Course = require('../models/course.schema');
  const CourseMaterial = require('../models/course-material.schema');
  const CourseMaterialChunk = require('../models/course-material-chunk.schema');
  const { createMediaStorage } = require('../services/media-storage.service');
  const { connectTestDb, disconnectTestDb } = require('./helpers/db');
  const { createPdfMaterialService, chunkPdfPages } = require('../services/pdf-material.service');
  let course;
  const uploader = new mongoose.Types.ObjectId();
  const sourcePages = [Array.from({ length: 850 }, (_, i) => `alpha${i}`).join(' '), Array.from({ length: 850 }, (_, i) => `beta${i}`).join(' ')];
  const bytes = Buffer.from('%PDF-1.7\nprivate original');

  test.before(async () => {
    await connectTestDb();
    await Promise.all([CourseMaterial.init(), CourseMaterialChunk.init()]);
    course = await Course.create({ title: 'PDF ingestion', description: 'Ingestion test', category: 'Programming', instructor: uploader,
      thumbnail: { public_id: 'thumb', secure_url: 'https://example.com/thumb.png' },
      lectures: [{ title: 'Introduction', lecture: { public_id: 'video', secure_url: 'https://example.com/lecture.mp4' } }] });
  });
  test.beforeEach(async () => {
    await CourseMaterialChunk.deleteMany({});
    await CourseMaterial.deleteMany({});
  });
  test.after(disconnectTestDb);

  function harness(overrides = {}) {
    const objects = new Map();
    const events = [];
    const storage = createMediaStorage({ readLocalFile: (localPath) => fs.readFile(localPath), r2: {
      put: async (entry) => { events.push('upload'); objects.set(entry.key, entry); },
      remove: async (key) => { objects.delete(key); events.push('remove'); }
    } });
    const service = createPdfMaterialService({ storage,
      parsePdf: async () => { events.push('parse'); return { pages: sourcePages }; },
      embedDocument: async (input) => { events.push('embed'); assert.deepEqual(Object.keys(input).sort(), ['text', 'title']); return Array(768).fill(0.25); },
      ...overrides });
    return { service, objects, events };
  }
  function input(file, overrides = {}) { return { file, course: course._id, lecture: course.lectures[0]._id, title: 'Course notes', uploadedBy: uploader, ...overrides }; }
  async function gone(file) { await assert.rejects(fs.stat(file.path), { code: 'ENOENT' }); }

  test('ingestion uploads the original privately, persists validated vectors and returns a safe READY result', async () => {
    const { service, objects, events } = harness();
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.deepEqual(result, { status: 'READY', materialId: result.materialId, failureCode: null });
      const material = await CourseMaterial.findById(result.materialId).lean();
      assert.equal(material.status, 'READY');
      assert.equal(material.pageCount, 2);
      assert.equal(material.extractedCharacterCount, sourcePages.reduce((sum, page) => sum + page.length, 0));
      assert.equal(String(material.lecture), String(course.lectures[0]._id));
      assert.equal(material.storage.provider, 'R2');
      assert.equal(material.storage.key, `materials/${course._id}/${material._id}/source.pdf`);
      assert.equal(objects.size, 1);
      assert.deepEqual(objects.get(material.storage.key).body, bytes);
      assert.equal(objects.get(material.storage.key).contentType, 'application/pdf');
      const chunks = await CourseMaterialChunk.find({ material: material._id }).sort('ordinal').lean();
      assert.deepEqual(chunks.map(({ ordinal, pageStart, pageEnd, text }) => ({ ordinal, pageStart, pageEnd, text })), chunkPdfPages(sourcePages));
      for (const chunk of chunks) {
        assert.equal(chunk.embedding.length, 768);
        assert.ok(chunk.embedding.every(Number.isFinite));
        assert.equal(chunk.embeddingModel, 'gemini-embedding-2');
        assert.equal(chunk.embeddingDimension, 768);
      }
      assert.deepEqual(events.slice(0, 2), ['parse', 'upload']);
      assert.ok(events.slice(2).every((event) => event === 'embed'));
      await gone(file);
    });
  });

  for (const [name, parsed, failureCode] of [
    ['encrypted', { encrypted: true, pages: ['secret'] }, 'ENCRYPTED_PDF'],
    ['no text', { pages: [''] }, 'NO_READABLE_TEXT'],
    ['over page limit', { pages: Array(101).fill('text') }, 'TOO_MANY_PAGES'],
    ['over character limit', { pages: ['x'.repeat(1000001)] }, 'EXTRACTION_FAILED']
  ]) test(`ingestion rejects ${name} before durable work and removes the temporary file`, async () => {
    const { service, objects } = harness({ parsePdf: async () => parsed });
    await withFile(bytes, async (file) => {
      assert.deepEqual(await service.ingestMaterial(input(file)), { status: 'FAILED', materialId: null, failureCode });
      assert.equal(objects.size, 0);
      assert.equal(await CourseMaterial.countDocuments(), 0);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('invalid title, ownership and lecture metadata are rejected before uploading', async () => {
    for (const overrides of [{ title: 'x'.repeat(121) }, { course: new mongoose.Types.ObjectId() }, { lecture: new mongoose.Types.ObjectId() }]) {
      const { service, objects } = harness();
      await withFile(bytes, async (file) => {
        const result = await service.ingestMaterial(input(file, overrides));
        assert.equal(result.status, 'FAILED');
        assert.equal(result.materialId, null);
        assert.equal(objects.size, 0);
        await gone(file);
      });
    }
    assert.equal(await CourseMaterial.countDocuments(), 0);
  });

  test('upload failure retains no source record or chunks and removes its temporary file', async () => {
    const { service } = harness({ storage: { uploadLocalFile: async () => { throw new Error('private R2 credential body'); } } });
    await withFile(bytes, async (file) => {
      assert.deepEqual(await service.ingestMaterial(input(file)), { status: 'FAILED', materialId: null, failureCode: 'STORAGE_FAILED' });
      assert.equal(await CourseMaterial.countDocuments(), 0);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('embedding failure retains a FAILED source for retry and removes every partial chunk', async () => {
    let count = 0;
    const { service, objects } = harness({ embedDocument: async () => {
      count += 1; if (count === 2) throw new Error('provider body with private text'); return Array(768).fill(0.25);
    } });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.deepEqual(result, { status: 'FAILED', materialId: result.materialId, failureCode: 'EMBEDDING_FAILED' });
      assert.ok(result.materialId);
      const material = await CourseMaterial.findById(result.materialId).lean();
      assert.equal(material.status, 'FAILED');
      assert.equal(material.failureCode, 'EMBEDDING_FAILED');
      assert.equal(objects.size, 1);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('an injected invalid vector never persists and leaves a retriable FAILED source', async () => {
    const { service, objects } = harness({ embedDocument: async () => Array(767).fill(0) });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.failureCode, 'EMBEDDING_FAILED');
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'FAILED');
      assert.equal(objects.size, 1);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('chunk persistence failure cleans partial chunks and keeps only a safe FAILED source', async () => {
    let created = 0;
    const { service, objects } = harness({ Chunk: {
      create: async (entry) => { created += 1; if (created === 2) throw new Error('database private text'); return CourseMaterialChunk.create(entry); },
      deleteMany: (filter) => CourseMaterialChunk.deleteMany(filter)
    } });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.failureCode, 'PROCESSING_FAILED');
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'FAILED');
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      assert.equal(objects.size, 1);
      await gone(file);
    });
  });

  test('READY save failure removes completed chunks and records a safe retriable failure', async (t) => {
    const original = CourseMaterial.prototype.save;
    t.mock.method(CourseMaterial.prototype, 'save', function (...args) {
      if (this.status === 'READY') throw new Error('database private body');
      return original.apply(this, args);
    });
    const { service, objects } = harness();
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.failureCode, 'PROCESSING_FAILED');
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'FAILED');
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      assert.equal(objects.size, 1);
      await gone(file);
    });
  });

  test('a database outage after upload preserves the PROCESSING reservation and private source for recovery', async (t) => {
    let outage = false;
    const original = CourseMaterial.prototype.save;
    t.mock.method(CourseMaterial.prototype, 'save', function (...args) {
      if (outage) throw new Error('database unavailable');
      return original.apply(this, args);
    });
    const { service, objects } = harness({ embedDocument: async () => { outage = true; throw new Error('processing failure'); } });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.status, 'FAILED');
      assert.ok(result.materialId);
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'PROCESSING');
      assert.equal(objects.size, 1);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('a transient partial-chunk cleanup error is retried before returning failure', async () => {
    let embeds = 0;
    let deletes = 0;
    const { service } = harness({
      embedDocument: async () => { embeds += 1; if (embeds === 2) throw new Error('provider unavailable'); return Array(768).fill(0.25); },
      Chunk: { create: (entry) => CourseMaterialChunk.create(entry), deleteMany: async (filter) => {
        deletes += 1; if (deletes === 1) throw new Error('temporary database error'); return CourseMaterialChunk.deleteMany(filter);
      } }
    });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.status, 'FAILED');
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'FAILED');
      await gone(file);
    });
  });

  test('a transient reservation removal error after failed upload is retried', async (t) => {
    const original = CourseMaterial.deleteOne;
    let deletes = 0;
    t.mock.method(CourseMaterial, 'deleteOne', async function (...args) {
      deletes += 1; if (deletes === 1) throw new Error('temporary database error'); return original.apply(this, args);
    });
    const { service } = harness({ storage: { uploadLocalFile: async () => { throw new Error('R2 unavailable'); } } });
    await withFile(bytes, async (file) => {
      assert.equal((await service.ingestMaterial(input(file))).failureCode, 'STORAGE_FAILED');
      assert.equal(await CourseMaterial.countDocuments(), 0);
      await gone(file);
    });
  });

  test('temporary Windows file locks are retried until the local source is removed', async () => {
    let unlinks = 0;
    const { service } = harness({ fsPromises: { ...fs, unlink: async (filePath) => {
      unlinks += 1; if (unlinks === 1) { const error = new Error('file locked'); error.code = 'EPERM'; throw error; } return fs.unlink(filePath);
    } } });
    await withFile(bytes, async (file) => {
      assert.equal((await service.ingestMaterial(input(file))).status, 'READY');
      await gone(file);
    });
  });

  test('uncertain failed upload retains its known reservation when R2 rollback fails', async () => {
    let retainedKey;
    const { service } = harness({ storage: {
      uploadLocalFile: async ({ key }) => { retainedKey = key; throw new Error('response lost after R2 put'); },
      remove: async () => { throw new Error('R2 unavailable'); }
    } });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.equal(result.failureCode, 'STORAGE_FAILED');
      assert.ok(result.materialId);
      const material = await CourseMaterial.findById(result.materialId).lean();
      assert.equal(material.storage.key, retainedKey);
      assert.equal(material.status, 'FAILED');
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });

  test('a persistent reservation removal failure returns the known material id for manager cleanup', async (t) => {
    t.mock.method(CourseMaterial, 'deleteOne', async () => { throw new Error('database delete unavailable'); });
    const { service } = harness({ storage: { uploadLocalFile: async () => { throw new Error('R2 unavailable'); } } });
    await withFile(bytes, async (file) => {
      const result = await service.ingestMaterial(input(file));
      assert.ok(result.materialId);
      assert.equal((await CourseMaterial.findById(result.materialId)).status, 'FAILED');
      assert.equal(result.failureCode, 'STORAGE_FAILED');
      await gone(file);
    });
  });

  test('public ingestion interface honors the supplied material identity and injected adapters', async () => {
    const { ingestMaterial } = require('../services/pdf-material.service');
    const materialId = new mongoose.Types.ObjectId();
    const { objects } = harness();
    const storage = createMediaStorage({ readLocalFile: (localPath) => fs.readFile(localPath), r2: {
      put: async (entry) => objects.set(entry.key, entry), remove: async (key) => objects.delete(key)
    } });
    await withFile(textPdf(['Public interface source.']), async (file) => {
      const result = await ingestMaterial({ materialId, courseId: course._id, localPath: file.path, originalName: 'notes.pdf',
        title: 'Interface notes', uploadedBy: uploader, storage, embedder: { embedDocument: async () => Array(768).fill(0.25) } });
      assert.equal(result.status, 'READY');
      assert.equal(result.materialId, String(materialId));
      assert.equal((await CourseMaterial.findById(materialId)).title, 'Interface notes');
      assert.equal(objects.size, 1);
      await gone(file);
    });
  });

  test('a duplicate explicit material identity cannot delete an existing source or its chunks', async () => {
    const first = harness();
    let materialId;
    await withFile(bytes, async (file) => { materialId = (await first.service.ingestMaterial(input(file))).materialId; });
    const before = await CourseMaterialChunk.countDocuments();
    const second = harness();
    await withFile(bytes, async (file) => {
      assert.equal((await second.service.ingestMaterial(input(file, { materialId }))).status, 'FAILED');
      assert.equal((await CourseMaterial.findById(materialId)).status, 'READY');
      assert.equal(await CourseMaterialChunk.countDocuments(), before);
      assert.equal(second.objects.size, 0);
      await gone(file);
    });
  });

  test('disabled runtime R2 never falls back or retains a reservation for an unattempted source upload', async () => {
    assert.equal(process.env.R2_ENABLED, 'false');
    const { service } = harness({ storage: undefined });
    await withFile(bytes, async (file) => {
      assert.deepEqual(await service.ingestMaterial(input(file)), { status: 'FAILED', materialId: null, failureCode: 'STORAGE_FAILED' });
      assert.equal(await CourseMaterial.countDocuments(), 0);
      assert.equal(await CourseMaterialChunk.countDocuments(), 0);
      await gone(file);
    });
  });
});
