const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { allowedByNameAndMime } = require('./media-validation.service');
const CourseMaterial = require('../models/course-material.schema');
const CourseMaterialChunk = require('../models/course-material-chunk.schema');
const { createRagEmbeddingService, isValidEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMENSION } = require('./rag-embedding.service');
const { createRuntimeMediaStorageFactory } = require('./runtime-media-storage.service');

const MAX_PDF_BYTES = 10485760;
const MAX_PDF_PAGES = 100;
const MAX_EXTRACTED_CHARS = 1000000;
const MAX_CHUNK_CHARS = 12000;
const CHUNK_TARGET_WORDS = 1000;
const CHUNK_OVERLAP_CHARS = 600;

class PdfMaterialError extends Error {
  constructor(code) {
    super('The PDF material could not be processed.');
    this.code = code;
  }
}

async function retryCleanup(operation) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await operation(); return true; } catch { /* Retain only a safe failure result. */ }
  }
  return false;
}

function checkPages(parsed) {
  if (parsed?.encrypted) throw new PdfMaterialError('ENCRYPTED_PDF');
  if (!Array.isArray(parsed?.pages)) throw new PdfMaterialError('EXTRACTION_FAILED');
  const pages = parsed.pages;
  if (pages.length > MAX_PDF_PAGES) throw new PdfMaterialError('TOO_MANY_PAGES');
  if (!pages.length) throw new PdfMaterialError('INVALID_PDF');
  if (pages.some((text) => typeof text !== 'string')) throw new PdfMaterialError('EXTRACTION_FAILED');
  const extractedCharacterCount = pages.reduce((count, text) => count + text.length, 0);
  if (extractedCharacterCount > MAX_EXTRACTED_CHARS) throw new PdfMaterialError('EXTRACTION_FAILED');
  if (!pages.some((text) => /[\p{L}\p{N}]/u.test(text))) throw new PdfMaterialError('NO_READABLE_TEXT');
  return { pages, pageCount: pages.length, extractedCharacterCount };
}

async function extractPdfPages(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true });
  // Refuse password-protected documents rather than requesting a password.
  task.onPassword = () => { task.destroy().catch(() => {}); };
  let document;
  try {
    document = await task.promise;
    const metadata = await document.getMetadata();
    if (metadata.info?.EncryptFilterName) throw new PdfMaterialError('ENCRYPTED_PDF');
    if (document.numPages > MAX_PDF_PAGES) throw new PdfMaterialError('TOO_MANY_PAGES');
    const pages = [];
    let total = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      let text = '';
      const reader = page.streamTextContent().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const part = item.str + (item.hasEOL ? '\n' : ' ');
            total += part.length;
            if (total > MAX_EXTRACTED_CHARS) throw new PdfMaterialError('EXTRACTION_FAILED');
            text += part;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        page.cleanup();
      }
      pages.push(text);
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

function chunkPdfPages(pages) {
  checkPages({ pages });
  const source = pages.join('\n');
  let offset = 0;
  const ranges = pages.map((text, index) => {
    const range = { start: offset, end: offset + text.length, page: index + 1 };
    offset += text.length + 1;
    return range;
  });
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    while (start < source.length && /\s/.test(source[start])) start += 1;
    if (start === source.length) break;
    let end = Math.min(start + MAX_CHUNK_CHARS, source.length);
    const words = source.slice(start, end).matchAll(/\S+/g);
    let count = 0;
    for (const match of words) {
      count += 1;
      if (count === CHUNK_TARGET_WORDS) { end = start + match.index + match[0].length; break; }
    }
    const text = source.slice(start, end).trimEnd();
    const last = start + text.length;
    const included = ranges.filter((range) => range.start < last && range.end > start);
    chunks.push({ ordinal: chunks.length, pageStart: included[0].page, pageEnd: included.at(-1).page, text });
    if (end === source.length) break;
    let next = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    // Start overlap at a word boundary when one exists within the bounded window.
    while (next < end && !/\s/.test(source[next - 1])) next += 1;
    if (next === end) next = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    start = next;
  }
  return chunks;
}

function createPdfMaterialService({ parsePdf = extractPdfPages, fsPromises = fs,
  Material = CourseMaterial, Chunk = CourseMaterialChunk, storage,
  embedDocument = createRagEmbeddingService().embedDocument } = {}) {
  const runtimeStorage = createRuntimeMediaStorageFactory();
  async function preparePdf(file) {
    try {
      if (!file?.path || !allowedByNameAndMime(file, 'material')) throw new PdfMaterialError('INVALID_PDF');
      const stat = await fsPromises.stat(file.path);
      if (stat.size > MAX_PDF_BYTES || file.size > MAX_PDF_BYTES) throw new PdfMaterialError('PDF_TOO_LARGE');
      if (!Number.isSafeInteger(stat.size) || stat.size < 1 || file.size !== stat.size) throw new PdfMaterialError('INVALID_PDF');
      const bytes = await fsPromises.readFile(file.path);
      if (bytes.length !== stat.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new PdfMaterialError('INVALID_PDF');
      const parsed = checkPages(await parsePdf(bytes));
      return { ...parsed, contentHash: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error instanceof PdfMaterialError) throw error;
      throw new PdfMaterialError(error?.name === 'PasswordException' ? 'ENCRYPTED_PDF' : 'EXTRACTION_FAILED');
    }
  }
  // Callers must complete course-manager authorization before invoking ingestion.
  async function ingestMaterial({ file, course, lecture = null, title, uploadedBy, materialId } = {}) {
    let material;
    let reserved = false;
    let uploaded = false;
    let uploadAttempted = false;
    let mediaStorage;
    let stage = 'PROCESSING_FAILED';
    let result;
    try {
      const prepared = await preparePdf(file);
      const chunks = chunkPdfPages(prepared.pages);
      if (!storage && process.env.R2_ENABLED !== 'true') throw new PdfMaterialError('STORAGE_FAILED');
      material = new Material({ ...(materialId ? { _id: materialId } : {}), course, lecture, title, uploadedBy,
        originalFilename: file.originalname, size: file.size, contentType: 'application/pdf',
        contentHash: prepared.contentHash, pageCount: prepared.pageCount,
        extractedCharacterCount: prepared.extractedCharacterCount, status: 'PROCESSING',
        storage: { provider: 'R2', key: 'materials/pending.pdf', contentType: 'application/pdf', size: file.size } });
      material.storage.key = `materials/${material.course}/${material._id}/source.pdf`;
      await material.validate();
      // Reserve a validated identity before R2 so a later DB outage cannot orphan the source.
      await material.save();
      reserved = true;
      stage = 'STORAGE_FAILED';
      mediaStorage = storage || runtimeStorage.get();
      uploadAttempted = true;
      await mediaStorage.uploadLocalFile({ provider: 'R2', localPath: file.path, key: material.storage.key,
        contentType: 'application/pdf', size: file.size });
      uploaded = true;
      for (const chunk of chunks) {
        stage = 'EMBEDDING_FAILED';
        const embedding = await embedDocument({ title: material.title, text: chunk.text });
        if (!isValidEmbedding(embedding)) throw new PdfMaterialError('EMBEDDING_FAILED');
        stage = 'PROCESSING_FAILED';
        await Chunk.create({ ...chunk, material: material._id, course: material.course, lecture: material.lecture,
          embedding, embeddingModel: EMBEDDING_MODEL, embeddingDimension: EMBEDDING_DIMENSION });
      }
      material.status = 'READY';
      await material.save();
      result = { status: 'READY', materialId: String(material._id), failureCode: null };
    } catch (error) {
      const failureCode = error instanceof PdfMaterialError ? error.code : stage;
      let retained = uploaded;
      if (material && reserved) {
        await retryCleanup(() => Chunk.deleteMany({ material: material._id }));
        if (!uploaded) {
          const sourceRemoved = !uploadAttempted || !mediaStorage?.remove
            || await retryCleanup(() => mediaStorage.remove({ storage: material.storage }));
          // An uncertain upload/rollback must keep its known identity for manager recovery.
          retained = !sourceRemoved || !await retryCleanup(() => Material.deleteOne({ _id: material._id }));
        }
        if (retained) {
          material.status = 'FAILED';
          material.failureCode = failureCode;
          // During a database outage the pre-upload PROCESSING reservation remains recoverable.
          await retryCleanup(() => material.save());
        }
      }
      result = { status: 'FAILED', materialId: retained ? String(material._id) : null, failureCode };
    } finally {
      if (file?.path) {
        const removed = await retryCleanup(async () => {
          try { await fsPromises.unlink(file.path); }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
        });
        if (!removed) throw new PdfMaterialError('PROCESSING_FAILED');
      }
    }
    return result;
  }
  return { preparePdf, ingestMaterial };
}

async function ingestMaterial({ materialId, courseId, localPath, originalName, storage, embedder,
  title, uploadedBy, lectureId = null, parsePdf, fsPromises = fs } = {}) {
  const size = localPath ? await fsPromises.stat(localPath).then((stat) => stat.size).catch(() => undefined) : undefined;
  return createPdfMaterialService({ storage, parsePdf, fsPromises,
    ...(embedder ? { embedDocument: (input) => embedder.embedDocument(input) } : {}) }).ingestMaterial({
    materialId, course: courseId, lecture: lectureId, title, uploadedBy,
    file: { path: localPath, originalname: originalName, mimetype: 'application/pdf', size }
  });
}

module.exports = { createPdfMaterialService, ingestMaterial, chunkPdfPages, MAX_PDF_BYTES, MAX_PDF_PAGES,
  MAX_EXTRACTED_CHARS, MAX_CHUNK_CHARS, CHUNK_OVERLAP_CHARS };
